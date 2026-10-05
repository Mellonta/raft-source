#!/usr/bin/env python3
"""Run the production services as the invoking Enroot user, without systemd."""
import fcntl
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import signal
import subprocess
import sys
import tarfile
import threading
import time
from urllib.request import urlopen

STATE = Path('/raft/state')
PG_BIN = '/usr/lib/postgresql/16/bin/'


def write(path, text):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(text)
    temporary.chmod(0o600)
    temporary.replace(path)


def identity():
    return {'pid': os.getpid(), 'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'ticks': Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19]}


def extra_environment(path):
    result = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if not separator or not key.replace('_', 'a').isalnum() or key[0].isdigit():
            raise ValueError('server-extra.env requires KEY=value entries, without shell commands')
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        result[key] = value
    return result


class Supervisor:
    def __init__(self, env):
        self.env = env
        self.children = []
        self.stopping = False

    def spawn(self, name, command, env=None):
        logger = logging.getLogger(name)
        logger.setLevel(logging.INFO)
        handler = RotatingFileHandler(STATE / 'logs' / (name + '.log'), maxBytes=10 * 1024**2, backupCount=3)
        logger.addHandler(handler)
        child = subprocess.Popen(command, cwd='/app', env=env or self.env,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, errors='replace', start_new_session=True)
        self.children.append((name, child))

        def collect():
            for line in child.stdout:
                logger.info(line.rstrip('\n'))
            child.stdout.close()
            handler.close()
        threading.Thread(target=collect, daemon=True).start()
        return child

    def check(self):
        if self.stopping:
            raise InterruptedError('Shutdown requested')
        for name, child in self.children:
            if child.poll() is not None:
                raise RuntimeError(f'{name} exited ({child.returncode}); see logs/{name}.log')

    def wait_for(self, probe, seconds=90):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.check()
            try:
                if probe():
                    return
            except (OSError, ValueError, subprocess.CalledProcessError):
                pass
            time.sleep(.25)
        raise RuntimeError('Service readiness timed out; see logs/')

    def run(self, name, command, env=None, seconds=300):
        child = self.spawn(name, command, env)
        deadline = time.monotonic() + seconds
        while child.poll() is None:
            if self.stopping or time.monotonic() >= deadline:
                raise RuntimeError(f'{name} interrupted or timed out; see logs/{name}.log')
            # Detect a database/cache crash while a migration is running.
            for other_name, other in self.children[:-1]:
                if other.poll() is not None:
                    raise RuntimeError(f'{other_name} exited during {name}')
            time.sleep(.1)
        self.children.remove((name, child))
        if child.returncode:
            raise RuntimeError(f'{name} failed ({child.returncode}); see logs/{name}.log')

    def close(self):
        # Stop ingress/API first, then Redis, then fast-shutdown PostgreSQL.
        for name, child in reversed(self.children):
            if child.poll() is not None:
                continue
            os.killpg(child.pid, signal.SIGINT if name == 'postgres' else signal.SIGTERM)
            try:
                child.wait(timeout=40)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()


def main():
    if os.geteuid() == 0:
        raise RuntimeError('Run Enroot as your normal user, without --root or root remapping.')
    os.umask(0o077)
    for name in ['run', 'logs', 'postgres', 'redis', 'uploads', 'tmp', 'home', 'cache', 'backups']:
        (STATE / name).mkdir(parents=True, exist_ok=True)
    with (STATE / 'service.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        settings = json.loads((STATE / 'settings.json').read_text())
        revision = Path('/opt/raft/revision').read_text().strip()
        own_identity = identity()
        write(STATE / 'run/runtime.json', json.dumps(own_identity))
        (STATE / 'run/ready.json').unlink(missing_ok=True)
        env = {'PATH': PG_BIN + ':/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8',
               'HOME': str(STATE / 'home'), 'TMPDIR': str(STATE / 'tmp'),
               'XDG_CACHE_HOME': str(STATE / 'cache')}
        env.update(extra_environment(STATE / 'server-extra.env'))
        env.update({
            'NODE_ENV': 'production', 'DEPLOYMENT_ENV': 'production',
            'HOST': '127.0.0.1', 'PORT': str(settings['api_port']),
            'METRICS_HOST': '127.0.0.1', 'METRICS_PORT': str(settings['metrics_port']),
            'DATABASE_URL': f"postgresql://raft:{settings['postgres_password']}@127.0.0.1:{settings['postgres_port']}/raft",
            'REDIS_URL': f"redis://:{settings['redis_password']}@127.0.0.1:{settings['redis_port']}",
            'JWT_SECRET': settings['jwt_secret'], 'AGENT_BOOTSTRAP_TOKEN_PEPPER': settings['bootstrap_pepper'],
            'SLOCK_MCP_CREDENTIAL_KEY': settings['mcp_key'],
            'SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED': 'true',
            'SERVER_URL': settings['public_url'], 'APP_URL': settings['public_url'], 'CORS_ORIGIN': settings['public_url'],
            'UPLOADS_DIR': str(STATE / 'uploads'), 'UPLOADS_LOCAL': 'true',
            'SLOCK_TRACE_OTLP_ENDPOINT': '', 'RAFT_TRACE_SCOPEDB_SINK': 'off',
            'RAFT_RELEASE_SHA': revision, 'SLOCK_RELEASE_SHA': revision,
        })
        pg_env = {**env, 'PGHOST': '127.0.0.1', 'PGPORT': str(settings['postgres_port']),
                  'PGUSER': 'raft', 'PGPASSWORD': settings['postgres_password'], 'PGDATABASE': 'postgres', 'PGCONNECT_TIMEOUT': '2'}
        supervisor = Supervisor(env)
        for sig in [signal.SIGTERM, signal.SIGINT]:
            signal.signal(sig, lambda *_: setattr(supervisor, 'stopping', True))
        try:
            pg = STATE / 'postgres'
            initialized = (pg / 'PG_VERSION').exists()
            if initialized and (pg / 'PG_VERSION').read_text().strip() != '16':
                raise RuntimeError('Existing database is not PostgreSQL 16; refusing an implicit major-version migration.')
            if not initialized:
                password_file = STATE / 'run/pg-password'
                write(password_file, settings['postgres_password'] + '\n')
                try:
                    supervisor.run('initdb', [PG_BIN + 'initdb', '-D', str(pg), '-U', 'raft',
                                             '--auth-host=scram-sha-256', '--auth-local=peer',
                                             '--encoding=UTF8', '--locale=C.UTF-8', '--pwfile=' + str(password_file)])
                finally:
                    password_file.unlink(missing_ok=True)
            supervisor.spawn('postgres', [PG_BIN + 'postgres', '-D', str(pg), '-h', '127.0.0.1',
                                         '-p', str(settings['postgres_port']), '-k', str(STATE / 'run')])
            supervisor.wait_for(lambda: subprocess.run([PG_BIN + 'psql', '-Atqc', 'SELECT 1'], env=pg_env,
                                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0)
            exists = subprocess.check_output([PG_BIN + 'psql', '-Atqc', "SELECT 1 FROM pg_database WHERE datname='raft'"], env=pg_env).strip()
            if not exists:
                supervisor.run('createdb', [PG_BIN + 'createdb', 'raft'], pg_env)
            redis_config = STATE / 'run/redis.conf'
            write(redis_config, f"bind 127.0.0.1\nport {settings['redis_port']}\nprotected-mode yes\n"
                  f"requirepass {settings['redis_password']}\ndir {STATE}/redis\nappendonly yes\nsave 60 1\ndaemonize no\n")
            supervisor.spawn('redis', ['redis-server', str(redis_config)])
            redis_env = {**env, 'REDISCLI_AUTH': settings['redis_password']}
            supervisor.wait_for(lambda: subprocess.check_output(['redis-cli', '-h', '127.0.0.1', '-p', str(settings['redis_port']), 'ping'],
                                                                 env=redis_env, stderr=subprocess.DEVNULL).strip() == b'PONG')
            stamp = STATE / 'migration-revision'
            if not stamp.exists() or stamp.read_text().strip() != revision:
                if exists:
                    backup = STATE / 'backups' / (time.strftime('%Y%m%dT%H%M%S') + '-' + str(os.getpid()))
                    backup.mkdir()
                    supervisor.run('backup', [PG_BIN + 'pg_dump', '-d', 'raft', '-Fc', '-f', str(backup / 'database.dump')], pg_env)
                    with tarfile.open(backup / 'files-and-config.tar.gz', 'w:gz') as archive:
                        for name in ['uploads', 'settings.json', 'server-extra.env']:
                            archive.add(STATE / name, arcname=name)
                migration_env = {**env, 'DATABASE_URL': env['DATABASE_URL'] + '?options=-c%20statement_timeout%3D60000',
                                 'SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS': '60000'}
                supervisor.run('migrate', ['pnpm', '--filter', '@botiverse/raft-server', 'db:migrate:deploy'], migration_env)
                write(stamp, revision + '\n')
            supervisor.spawn('server', ['node', '--import', 'tsx', 'packages/server/src/server.ts'])

            def healthy(port):
                with urlopen(f'http://127.0.0.1:{port}/health', timeout=2) as response:
                    return json.load(response)['status'] == 'ok'
            supervisor.wait_for(lambda: healthy(settings['api_port']))
            nginx = Path('/opt/raft/enroot-nginx.conf').read_text()
            substitutions = {'BIND': settings['bind'], 'WEB_PORT': settings['port'], 'API_PORT': settings['api_port'],
                             'MANIFEST_SHA': hashlib.sha256(Path('/app/packages/web/dist/desktop-manifest.json').read_bytes()).hexdigest()}
            for key, value in substitutions.items():
                nginx = nginx.replace('@' + key + '@', str(value))
            write(STATE / 'run/nginx.conf', nginx)
            supervisor.spawn('web', ['nginx', '-c', str(STATE / 'run/nginx.conf')])
            supervisor.wait_for(lambda: (STATE / 'run/nginx.pid').exists())
            write(STATE / 'run/ready.json', json.dumps({**own_identity, 'revision': revision}))
            print('Raft is ready at ' + settings['public_url'], flush=True)
            while not supervisor.stopping:
                supervisor.check()
                time.sleep(.5)
        finally:
            (STATE / 'run/ready.json').unlink(missing_ok=True)
            supervisor.close()
            (STATE / 'run/runtime.json').unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        main()
    except InterruptedError:
        pass
    except Exception as error:
        print('Raft startup failed: ' + str(error), file=sys.stderr, flush=True)
        sys.exit(1)
