#!/usr/bin/env python3
"""User-owned Enroot deployment. Host requirements: Python 3.9+ and working Enroot."""
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
import time
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

REPOSITORY = 'Mellonta/raft-source'
IMAGE_NAME = 'raft-server-linux-x64.sqsh'
RELEASE_PREFIX = 'enroot-server-'


def write(path, text):
    temporary = path.with_name(path.name + '.tmp')
    with open(temporary, 'w', opener=lambda p, flags: os.open(p, flags, 0o600)) as stream:
        stream.write(text)
    temporary.chmod(0o600)
    temporary.replace(path)


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024**2), b''):
            value.update(block)
    return value.hexdigest()


def request_json(url):
    with urlopen(Request(url, headers={'User-Agent': 'mellonta-raft-setup', 'Accept': 'application/json'}), timeout=60) as response:
        return json.load(response)


def get_image(args, images):
    if args.image:
        if not args.manifest:
            raise ValueError('--image requires --manifest from the same build')
        manifest = json.loads(Path(args.manifest).expanduser().read_text())
    else:
        tag = args.release
        if not tag:
            # Keep the Computer /releases/latest pointer independent of server images.
            for page in range(1, 11):
                releases = request_json(f'https://api.github.com/repos/{REPOSITORY}/releases?per_page=100&page={page}')
                matches = [r for r in releases if not r['draft'] and r['tag_name'].startswith(RELEASE_PREFIX)]
                if matches:
                    tag = matches[0]['tag_name']
                    break
                if len(releases) < 100:
                    break
        if not tag or not re.fullmatch(RELEASE_PREFIX + '[0-9a-f]{40}', tag):
            raise ValueError('No published Enroot server image found; check the Mellonta Enroot release workflow')
        base = f'https://github.com/{REPOSITORY}/releases/download/{tag}'
        manifest = request_json(base + '/enroot-manifest.json')
        if tag != RELEASE_PREFIX + manifest.get('commit', ''):
            raise ValueError('Image manifest does not match the requested release')
    if (manifest.get('schema') != 1 or manifest.get('image') != IMAGE_NAME
            or not re.fullmatch('[0-9a-f]{40}', manifest.get('commit', ''))
            or not re.fullmatch('[0-9a-f]{64}', manifest.get('sha256', ''))):
        raise ValueError('Invalid Enroot image manifest')
    images.mkdir(parents=True, exist_ok=True)
    target = images / (manifest['commit'] + '.sqsh')
    if target.exists() and digest(target) == manifest['sha256']:
        return target, manifest
    temporary = target.with_suffix('.download')
    try:
        if args.image:
            shutil.copyfile(Path(args.image).expanduser(), temporary)
        else:
            with urlopen(base + '/' + IMAGE_NAME, timeout=120) as response, temporary.open('wb') as out:
                shutil.copyfileobj(response, out)
        if digest(temporary) != manifest['sha256']:
            raise ValueError('Image checksum mismatch; installation has not been activated')
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return target, manifest


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
    _ = url.port
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
        print('Raft is stopped.')
        return
    os.kill(record['pid'], signal.SIGTERM)
    deadline = time.monotonic() + 150
    while time.monotonic() < deadline:
        if not live(state) and not live(state, 'launcher'):
            print('Raft stopped; data retained.')
            return
        time.sleep(.25)
    raise RuntimeError('Graceful shutdown timed out; inspect logs before restarting')


def enroot_env(root):
    result = os.environ.copy()
    for name, subdir in [('ENROOT_DATA_PATH', 'data'), ('ENROOT_CACHE_PATH', 'cache'),
                         ('ENROOT_RUNTIME_PATH', 'run'), ('ENROOT_CONFIG_PATH', 'config'), ('TMPDIR', 'tmp')]:
        path = root / '.enroot' / subdir
        path.mkdir(parents=True, exist_ok=True)
        path.chmod(0o700)
        result[name] = str(path)
    result.update(ENROOT_REMAP_ROOT='n', ENROOT_LOGIN_SHELL='n', ENROOT_MOUNT_HOME='n',
                  NVIDIA_VISIBLE_DEVICES='void')
    return result


def start(root, state, foreground=False, operation_lock=None):
    if live(state) or live(state, 'launcher'):
        print('Raft is already running. Use restart to reload settings.')
        return
    installation = json.loads((state / 'installation.json').read_text())
    settings = json.loads((state / 'settings.json').read_text())
    for key in ['port', 'api_port', 'metrics_port', 'postgres_port', 'redis_port']:
        address = settings['bind'] if key == 'port' else '127.0.0.1'
        with socket.socket() as probe:
            try:
                probe.bind((address, settings[key]))
            except OSError as error:
                raise RuntimeError(f'{key} {settings[key]} is unavailable on {address}; rerun setup with a different --{key.replace("_", "-")}') from error
    env = enroot_env(root)
    command = ['enroot', 'start', '--conf', str(state / 'enroot.conf'),
               '--mount', str(state) + ':/raft/state', installation['container'],
               'python3', '/opt/raft/enroot-runtime.py']
    log = state / 'logs/bootstrap.log'
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
        deadline = time.monotonic() + 300
        host = '127.0.0.1' if settings['bind'] == '0.0.0.0' else settings['bind']
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError('Enroot server exited during startup; inspect logs/bootstrap.log and logs/migrate.log')
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
            raise RuntimeError('Startup exceeded five minutes; inspect logs/')
        print('Raft is healthy at ' + settings['public_url'], flush=True)
        if foreground and operation_lock is not None:
            fcntl.flock(operation_lock, fcntl.LOCK_UN)
        if foreground and child.wait() != 0:
            raise RuntimeError('Enroot exited with an error; inspect logs/')
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
    parser.add_argument('--release', help='Exact enroot-server-COMMIT release (default latest server release)')
    parser.add_argument('--image', type=Path, help='Use a local .sqsh image with --manifest (offline install/CI)')
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--no-start', action='store_true', help='Prepare deployment; start.sh initializes it later')
    parser.add_argument('--foreground', action='store_true', help='Keep running in the current scheduler job/terminal')
    parser.add_argument('--service', choices=['bootstrap', 'server', 'postgres', 'redis', 'web', 'migrate'], default='server')
    args = parser.parse_args()
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        parser.error('This image requires Linux x86-64')
    if os.geteuid() == 0:
        parser.error('Run as your normal cluster user, without sudo')
    if not shutil.which('enroot'):
        parser.error('Enroot must already be installed and working for your account')
    os.umask(0o077)
    root = args.root.expanduser().resolve()
    if re.search(r'[:\s\\]', str(root)):
        parser.error('Enroot mount paths must not contain whitespace, colons, or backslashes')
    state = root / '.raft-prod'
    if state.is_symlink():
        parser.error('State directory must not be a symlink')
    state.mkdir(parents=True, exist_ok=True)
    if state.stat().st_uid != os.getuid():
        parser.error('State directory must belong to the current user')
    state.chmod(0o700)
    for name in ['run', 'logs', 'images']:
        (state / name).mkdir(exist_ok=True)
    if args.command == 'logs':
        os.execvp('tail', ['tail', '-n', '100', '-F', str(state / 'logs' / (args.service + '.log'))])
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
            settings = configure(state, args)
            image, manifest = get_image(args, state / 'images')
            env = enroot_env(root)
            name = 'raft-server-' + manifest['commit']
            container = Path(env['ENROOT_DATA_PATH']) / name
            if not container.exists():
                staging_name = name + '-staging-' + str(os.getpid())
                subprocess.run(['enroot', 'create', '--name', staging_name, str(image)], env=env, check=True)
                staging = Path(env['ENROOT_DATA_PATH']) / staging_name
                if (staging / 'opt/raft/revision').read_text().strip() != manifest['commit']:
                    raise ValueError('Extracted image revision does not match the manifest')
                staging.rename(container)
            # Complete the download and extraction before stopping the old server.
            stop(state)
            write(state / 'settings.json', json.dumps(settings, indent=2) + '\n')
            write(state / 'installation.json', json.dumps({'container': name, **manifest}, indent=2) + '\n')
            extra = state / 'server-extra.env'
            if not extra.exists():
                write(extra, '# Optional server environment, preserved by setup. No shell commands.\n# RESEND_API_KEY=...\n')
            write(state / 'enroot.conf', '#ENROOT_REMAP_ROOT=n\n#ENROOT_LOGIN_SHELL=n\n#ENROOT_MOUNT_HOME=n\nrc() { exec "$@"; }\n')
            # Keep management commands independent of the checkout's location.
            write(state / 'control.py', Path(__file__).read_text())
            for filename, command in [('start.sh', 'start'), ('raftprod', '')]:
                prefix = 'exec python3 ' + shlex.quote(str(state / 'control.py'))
                write(state / filename, '#!/usr/bin/env bash\n' + prefix + ' ' + command +
                      ' --root ' + shlex.quote(str(root)) + ' "$@"\n')
            print('Installed server image from commit ' + manifest['commit'], flush=True)
            print('Start: bash ' + str(state / 'start.sh'), flush=True)
            if args.no_start:
                return
        elif args.command == 'restart':
            stop(state)
        if not (state / 'installation.json').exists():
            raise RuntimeError('Run setup-enroot.sh --url URL first')
        start(root, state, args.foreground, lock)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print('ERROR: ' + str(error), file=sys.stderr)
        sys.exit(1)
