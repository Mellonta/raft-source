#!/usr/bin/env python3
"""Native user-owned deployment. Host requirements: Linux, Bash and Python 3.9+."""
import argparse
import base64
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

REPOSITORY = 'Mellonta/raft-source'
RELEASE_PREFIX = 'server-'


def report(message):
    print('[raft setup] ' + message, file=sys.stderr, flush=True)


class Progress:
    """Keep blocking work visible, including when output is redirected or piped."""
    def __init__(self, label, interval=5):
        self.label = label
        self.interval = interval
        self.detail = ''
        self.finished = threading.Event()

    def __enter__(self):
        self.started = time.monotonic()
        report(self.label)

        def heartbeat():
            while not self.finished.wait(self.interval):
                detail = ': ' + self.detail if self.detail else ''
                report(f'{self.label}{detail} ({time.monotonic() - self.started:.0f}s elapsed)')
        self.thread = threading.Thread(target=heartbeat, daemon=True)
        self.thread.start()
        return self

    def transferred(self, count, total=None):
        self.detail = f'{count / 1024**2:.1f} MiB'
        if total:
            self.detail += f' / {total / 1024**2:.1f} MiB ({count / total:.0%})'

    def __exit__(self, kind, value, traceback):
        self.finished.set()
        self.thread.join()
        outcome = 'done' if kind is None else 'interrupted' if kind is KeyboardInterrupt else 'failed'
        detail = ': ' + self.detail if self.detail else ''
        report(f'{self.label}{detail} — {outcome} ({time.monotonic() - self.started:.1f}s)')


def linux_target():
    machine = platform.machine().lower()
    if machine in ('x86_64', 'amd64'):
        return 'linux-x64'
    if machine in ('aarch64', 'arm64'):
        return 'linux-arm64'
    raise ValueError('This bundle requires Linux x86-64 or ARM64')


def manifest_name(target):
    return f'server-manifest-{target}.json'


def validate_platform(manifest):
    target = linux_target()
    if manifest.get('platform') != target or manifest.get('bundle') != f'raft-server-{target}.tar.gz':
        raise ValueError(f'Bundle architecture mismatch: this machine requires {target}')


def write(path, text):
    temporary = path.with_name(path.name + '.tmp')
    with open(temporary, 'w', opener=lambda p, flags: os.open(p, flags, 0o600)) as stream:
        stream.write(text)
    temporary.chmod(0o600)
    temporary.replace(path)


def digest(path):
    value = hashlib.sha256()
    with Progress('Verifying bundle SHA-256') as progress, path.open('rb') as stream:
        count, total = 0, path.stat().st_size
        for block in iter(lambda: stream.read(1024**2), b''):
            value.update(block)
            count += len(block)
            progress.transferred(count, total)
    return value.hexdigest()


def request_json(url):
    with Progress('Fetching release metadata'):
        with urlopen(Request(url, headers={'User-Agent': 'mellonta-raft-setup', 'Accept': 'application/json'}), timeout=60) as response:
            return json.load(response)


def get_bundle(args, downloads):
    target_platform = linux_target()
    bundle_name = f'raft-server-{target_platform}.tar.gz'
    if args.bundle:
        if not args.manifest:
            raise ValueError('--bundle requires --manifest from the same build')
        manifest = json.loads(Path(args.manifest).expanduser().read_text())
    else:
        tag = args.release
        report(f'Selecting {tag or "latest native server release"} for {target_platform}')
        if not tag:
            # Keep the Computer /releases/latest pointer independent of server bundles.
            for page in range(1, 11):
                releases = request_json(f'https://api.github.com/repos/{REPOSITORY}/releases?per_page=100&page={page}')
                matches = [r for r in releases if not r['draft'] and r['tag_name'].startswith(RELEASE_PREFIX)]
                if matches:
                    tag = matches[0]['tag_name']
                    break
                if len(releases) < 100:
                    break
        if not tag or not re.fullmatch(RELEASE_PREFIX + '[0-9a-f]{40}', tag):
            raise ValueError('No published native server bundle found; check the Mellonta server release workflow')
        base = f'https://github.com/{REPOSITORY}/releases/download/{tag}'
        manifest = request_json(base + '/' + manifest_name(target_platform))
        if tag != RELEASE_PREFIX + manifest.get('commit', ''):
            raise ValueError('Bundle manifest does not match the requested release')
    validate_platform(manifest)
    if (manifest.get('schema') != 1
            or not re.fullmatch('[0-9a-f]{40}', manifest.get('commit', ''))
            or not re.fullmatch('[0-9a-f]{64}', manifest.get('sha256', ''))):
        raise ValueError('Invalid server bundle manifest')
    downloads.mkdir(parents=True, exist_ok=True)
    report('Server revision: ' + manifest['commit'])
    target = downloads / (manifest['commit'] + '-' + target_platform + '.tar.gz')
    if target.exists() and digest(target) == manifest['sha256']:
        report('Using verified cached bundle: ' + str(target))
        return target, manifest
    temporary = target.with_suffix('.download')
    try:
        if args.bundle:
            with Progress('Copying local server bundle'):
                shutil.copyfile(Path(args.bundle).expanduser(), temporary)
        else:
            with Progress('Downloading ' + bundle_name) as progress:
                with urlopen(base + '/' + bundle_name, timeout=120) as response, temporary.open('wb') as out:
                    length = response.headers.get('Content-Length', '')
                    total = int(length) if length.isdigit() else None
                    count = 0
                    progress.transferred(count, total)
                    for block in iter(lambda: response.read(1024**2), b''):
                        out.write(block)
                        count += len(block)
                        progress.transferred(count, total)
                    if total is not None and count != total:
                        raise ValueError('Incomplete bundle download; rerun setup to retry')
        if digest(temporary) != manifest['sha256']:
            raise ValueError('Bundle checksum mismatch; installation has not been activated')
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return target, manifest


def extract_archive(archive, destination, label='Extracting archive'):
    """Reject traversal, escaping links, devices and special modes on Python 3.9+."""
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    def contained(path):
        if path != root and root not in path.parents:
            raise ValueError('Archive path escapes its destination')
    with Progress(label) as progress, tarfile.open(archive, 'r:gz') as source:
        for count, member in enumerate(source, 1):
            if Path(member.name).is_absolute() or '..' in Path(member.name).parts:
                raise ValueError('Unsafe archive path')
            path = (root / member.name).resolve()
            contained(path)
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise ValueError('Unsupported archive entry')
            if member.issym() or member.islnk():
                link = Path(member.linkname)
                if link.is_absolute():
                    raise ValueError('Absolute archive link')
                contained(((path.parent if member.issym() else root) / link).resolve())
            member.mode &= 0o777
            # Validated above rather than relying on filters absent in Python 3.9.
            source.extract(member, root)
            progress.detail = f'{count:,} entries extracted'


def prepare_bundle(archive, manifest, releases):
    target = releases / (manifest['commit'] + '-' + manifest['platform'])
    marker = target / '.ready'
    if marker.is_file() and marker.read_text().strip() == manifest['sha256']:
        report('Using prepared runtime: ' + str(target))
        return target
    if target.exists():
        raise ValueError(f'Incomplete runtime at {target}; remove that extracted directory and rerun setup')
    releases.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.extract-', dir=releases))
    try:
        extract_archive(archive, staging, 'Extracting application bundle')
        if (staging / 'revision').read_text().strip() != manifest['commit']:
            raise ValueError('Extracted revision does not match the manifest')
        extract_archive(staging / 'runtime.tar.gz', staging / 'runtime', 'Extracting bundled runtime')
        (staging / 'runtime.tar.gz').unlink()
        staging.rename(target)
        # Conda's prefix rewriting must happen at the final path. The packed
        # runtime includes its own Python; no conda/mamba is used on the host.
        runtime = target / 'runtime'
        with Progress('Configuring runtime paths'):
            subprocess.run([str(runtime / 'bin/python'), str(runtime / 'bin/conda-unpack')],
                           env={'PATH': str(runtime / 'bin') + ':/usr/bin:/bin', 'HOME': str(target)}, check=True)
        write(marker, manifest['sha256'] + '\n')
        return target
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def configure(state, args):
    saved = state / 'settings.json'
    if saved.exists():
        settings = json.loads(saved.read_text())
    else:
        if (state / 'postgres').exists() and any((state / 'postgres').iterdir()):
            raise ValueError('Database exists without settings.json; refusing to replace its credentials')
        settings = {'public_url': None, 'bind': '0.0.0.0', 'port': 8080, 'api_port': 3001,
                    'metrics_port': 9090, 'postgres_port': 5432, 'redis_port': 6379,
                    **{key: secrets.token_hex(32) for key in ['postgres_password', 'redis_password', 'jwt_secret', 'bootstrap_pepper']},
                    'mcp_key': base64.b64encode(secrets.token_bytes(32)).decode()}
    for key in ['public_url', 'bind', 'port', 'api_port', 'metrics_port', 'postgres_port', 'redis_port']:
        value = getattr(args, key, None)
        if value is not None:
            settings[key] = value
    url = urlsplit(settings['public_url'] or '')
    if (url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password
            or url.path not in ('', '/') or url.query or url.fragment
            or re.search(r'[\s\x00-\x1f]', settings['public_url'])):
        raise ValueError('First setup requires --url with the portal origin, e.g. http://a.b.com:8080')
    url_port = url.port
    if getattr(args, 'public_url', None) is not None and getattr(args, 'port', None) is None and url.scheme == 'http' and url_port is not None:
        settings['port'] = url_port
    settings['public_url'] = settings['public_url'].rstrip('/')
    ipaddress.IPv4Address(settings['bind'])
    ports = [settings[key] for key in ['port', 'api_port', 'metrics_port', 'postgres_port', 'redis_port']]
    if len(set(ports)) != 5 or not all(isinstance(p, int) and 1024 <= p <= 65535 for p in ports):
        raise ValueError('All five ports must be distinct numbers between 1024 and 65535')
    for key in ['postgres_password', 'redis_password', 'jwt_secret', 'bootstrap_pepper']:
        if not re.fullmatch('[0-9a-f]{64}', settings[key]):
            raise ValueError('Invalid saved secret: ' + key)
    if len(base64.b64decode(settings['mcp_key'], validate=True)) != 32:
        raise ValueError('Invalid saved MCP key')
    return settings


def process_identity(pid):
    return {'pid': pid, 'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'ticks': Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]}


def live(state, name='runtime'):
    path = state / 'run' / (name + '.json')
    try:
        record = json.loads(path.read_text())
    except FileNotFoundError:
        return None
    if record['boot'] != Path('/proc/sys/kernel/random/boot_id').read_text().strip():
        # A reboot or a completed scheduler job can leave stale PID files. The
        # database owner's lock, including on shared storage, decides liveness.
        with (state / 'service.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise RuntimeError('This data directory is running on another node; stop that instance first') from error
        return None
    try:
        if process_identity(record['pid']) == {key: record[key] for key in ['pid', 'boot', 'ticks']}:
            # A zombie is finished and cannot respond to stop.
            if Path(f"/proc/{record['pid']}/stat").read_text().rsplit(')', 1)[1].split()[0] != 'Z':
                return record
    except (FileNotFoundError, ProcessLookupError):
        pass
    return None


def stop(state):
    record = live(state) or live(state, 'launcher')
    if not record:
        print('Raft is stopped.', flush=True)
        return
    with Progress('Stopping existing Raft services'):
        os.kill(record['pid'], signal.SIGTERM)
        deadline = time.monotonic() + 150
        while time.monotonic() < deadline:
            if not live(state) and not live(state, 'launcher'):
                print('Raft stopped; data retained.', flush=True)
                return
            time.sleep(.25)
        raise RuntimeError('Graceful shutdown timed out; inspect logs before restarting')


def probe_port(address, port):
    with socket.socket() as probe:
        # Match the real services: TIME_WAIT connections from a clean stop do
        # not occupy a listening port, but another live listener still does.
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind((address, port))


def start(root, state, foreground=False, operation_lock=None):
    if live(state) or live(state, 'launcher'):
        print('Raft is already running. Use restart to reload settings.', flush=True)
        return
    installation = json.loads((state / 'installation.json').read_text())
    validate_platform(installation)
    settings = json.loads((state / 'settings.json').read_text())
    for key in ['port', 'api_port', 'metrics_port', 'postgres_port', 'redis_port']:
        address = settings['bind'] if key == 'port' else '127.0.0.1'
        try:
            probe_port(address, settings[key])
        except OSError as error:
            raise RuntimeError(f'{key} {settings[key]} is unavailable on {address}; rerun setup with a different --{key.replace("_", "-")}') from error
    bundle = Path(installation['directory'])
    command = [str(bundle / 'runtime/bin/python'), str(bundle / 'native-runtime.py'), str(state)]
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(state / 'home')}
    log = state / 'logs/bootstrap.log'
    report('Starting Raft services; logs: ' + str(state / 'logs'))
    report('Startup details: tail -F ' + shlex.quote(str(log)) + ' ' + shlex.quote(str(state / 'logs/migrate.log')))
    if log.exists() and log.stat().st_size > 10 * 1024**2:
        log.replace(log.with_suffix('.log.1'))
    with log.open('a') as output:
        child = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL,
                                 stdout=None if foreground else output, stderr=None if foreground else output,
                                 start_new_session=True)
    write(state / 'run/launcher.json', json.dumps(process_identity(child.pid)))

    def forward(sig, _frame):
        # Runtime receives TERM and shuts its separately grouped children down.
        record = live(state)
        if record:
            os.kill(record['pid'], sig)
        elif child.poll() is None:
            os.killpg(child.pid, sig)
    previous = {sig: signal.signal(sig, forward) for sig in [signal.SIGTERM, signal.SIGINT]}
    try:
        with Progress('Waiting for database initialization, migrations, and portal health'):
            deadline = time.monotonic() + 300
            host = '127.0.0.1' if settings['bind'] == '0.0.0.0' else settings['bind']
            while time.monotonic() < deadline:
                if child.poll() is not None:
                    raise RuntimeError(f'Server exited during startup; inspect {log} and {state / "logs/migrate.log"}')
                ready = state / 'run/ready.json'
                if ready.exists() and live(state):
                    try:
                        with urlopen(f"http://{host}:{settings['port']}/health", timeout=2) as response:
                            if json.load(response)['status'] == 'ok':
                                break
                    except (OSError, ValueError):
                        pass
                time.sleep(.5)
            else:
                stop(state)
                raise RuntimeError(f'Startup exceeded five minutes; inspect {state / "logs"}')
        print('Raft is healthy at ' + settings['public_url'], flush=True)
        if foreground and operation_lock is not None:
            fcntl.flock(operation_lock, fcntl.LOCK_UN)
        if foreground and child.wait() != 0:
            raise RuntimeError('Server exited with an error; inspect logs/')
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        if child.poll() is not None:
            (state / 'run/launcher.json').unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['deploy', 'start', 'stop', 'restart', 'status', 'logs'])
    parser.add_argument('--root', type=Path, default=Path.home() / 'park')
    parser.add_argument('--url', dest='public_url')
    parser.add_argument('--bind')
    for name in ['port', 'api-port', 'metrics-port', 'postgres-port', 'redis-port']:
        parser.add_argument('--' + name, type=int)
    parser.add_argument('--release', help='Exact server-COMMIT release (default latest server release)')
    parser.add_argument('--bundle', type=Path, help='Use a local .tar.gz bundle with --manifest (offline install/CI)')
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--no-start', action='store_true', help='Prepare deployment; start.sh initializes it later')
    parser.add_argument('--foreground', action='store_true', help='Keep running in the current scheduler job/terminal')
    parser.add_argument('--service', choices=['bootstrap', 'server', 'postgres', 'redis', 'web', 'migrate'], default='server')
    args = parser.parse_args()
    if platform.system() != 'Linux':
        parser.error('This bundle requires Linux')
    linux_target()
    if os.geteuid() == 0:
        parser.error('Run as your normal cluster user, without sudo')
    os.umask(0o077)
    root = args.root.expanduser().resolve()
    if re.search(r'[:\s\\]', str(root)):
        parser.error('Runtime paths must not contain whitespace, colons, or backslashes')
    state = root / '.raft-prod'
    if state.is_symlink():
        parser.error('State directory must not be a symlink')
    state.mkdir(parents=True, exist_ok=True)
    if state.stat().st_uid != os.getuid():
        parser.error('State directory must belong to the current user')
    state.chmod(0o700)
    for name in ['run', 'logs', 'downloads']:
        (state / name).mkdir(exist_ok=True)
    if args.command == 'logs':
        os.execvp('tail', ['tail', '-n', '100', '-F', str(state / 'logs' / (args.service + '.log'))])
    if args.command == 'deploy':
        report(f'Setting up Raft for {linux_target()}. State: {state}')
    # The foreground runtime holds service.lock; do not hold the operation lock
    # throughout a foreground job, otherwise a separate stop could never run.
    with (state / 'operation.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command == 'status':
            running = live(state)
            print('Raft is ' + ('running' if running else 'stopped') + '. State: ' + str(state))
            return
        if args.command == 'stop':
            stop(state)
            return
        if args.command == 'deploy':
            saved_install = state / 'installation.json'
            if saved_install.exists() and 'container' in json.loads(saved_install.read_text()):
                raise ValueError('This directory belongs to a retired Enroot deployment; use a fresh --root for native setup')
            settings = configure(state, args)
            archive, manifest = get_bundle(args, state / 'downloads')
            bundle = prepare_bundle(archive, manifest, state / 'releases')
            # Complete the download and extraction before stopping the old server.
            stop(state)
            write(state / 'settings.json', json.dumps(settings, indent=2) + '\n')
            write(state / 'installation.json', json.dumps({'directory': str(bundle), **manifest}, indent=2) + '\n')
            extra = state / 'server-extra.env'
            if not extra.exists():
                write(extra, '# Optional server environment, preserved by setup. No shell commands.\n# RESEND_API_KEY=...\n')
            # Keep management commands independent of the checkout's location.
            write(state / 'control.py', Path(__file__).read_text())
            for filename, command in [('start.sh', 'start'), ('raftprod', '')]:
                prefix = 'exec python3 ' + shlex.quote(str(state / 'control.py'))
                write(state / filename, '#!/usr/bin/env bash\n' + prefix + ' ' + command +
                      ' --root ' + shlex.quote(str(root)) + ' "$@"\n')
            print('Installed native server from commit ' + manifest['commit'], flush=True)
            print('Start: bash ' + str(state / 'start.sh'), flush=True)
            if args.no_start:
                return
        elif args.command == 'restart':
            stop(state)
        if not (state / 'installation.json').exists():
            raise RuntimeError('Run setup-server.sh --url URL first')
        start(root, state, args.foreground, lock)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print('ERROR: ' + str(error), file=sys.stderr)
        sys.exit(1)
