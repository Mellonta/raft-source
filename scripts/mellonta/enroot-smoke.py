#!/usr/bin/env python3
"""Run the real image as an ordinary CI user with sudo/Docker/apt blocked."""
import hashlib
import os
import platform
from pathlib import Path
import socket
import subprocess
import sys
import time

source = Path(__file__).resolve().parents[2]
assets = Path(sys.argv[1]).resolve()
temp = Path(os.environ['RUNNER_TEMP'])
home = temp / 'enroot-user'
home.mkdir(exist_ok=True)
guard = temp / 'forbidden-commands'
guard.mkdir(exist_ok=True)
for name in ['sudo', 'docker', 'apt', 'apt-get', 'systemctl']:
    path = guard / name
    path.write_text('#!/bin/sh\necho "Forbidden host command: ' + name + '" >&2\nexit 99\n')
    path.chmod(0o700)
env = {**os.environ, 'HOME': str(home), 'PATH': str(guard) + ':' + os.environ['PATH']}
state = home / 'park/.raft-prod'
setup = ['bash', str(source / 'scripts/mellonta/setup-enroot.sh')]
target = 'linux-arm64' if platform.machine() in ('aarch64', 'arm64') else 'linux-x64'
manifest = 'enroot-manifest-linux-arm64.json' if target == 'linux-arm64' else 'enroot-manifest.json'
image_args = ['--image', str(assets / f'raft-server-{target}.sqsh'),
              '--manifest', str(assets / manifest)]


def run(command):
    subprocess.run(command, cwd=source, env=env, check=True)


def manage(*args):
    run(['bash', str(state / 'raftprod'), *args])


def smoke():
    run(['python3', str(source / 'scripts/mellonta/prod-smoke.py')])
    # API and metrics must be reachable only through loopback on the host.
    address = socket.gethostbyname(socket.gethostname())
    if address != '127.0.0.1':
        for port in [3001, 9090, 5432, 6379]:
            with socket.socket() as probe:
                probe.settimeout(2)
                assert probe.connect_ex((address, port)) != 0, f'Private service exposed on {address}:{port}'


try:
    state.mkdir(parents=True, exist_ok=True)
    # Only the disposable CI deployment can auto-verify synthetic accounts.
    (state / "server-extra.env").write_text("SLOCK_E2E_AUTO_VERIFY_EMAIL=1\n")
    run(setup + ['--url', 'http://127.0.0.1:8080', '--bind', '127.0.0.1', *image_args])
    smoke()
    before = hashlib.sha256((state / 'settings.json').read_bytes()).hexdigest()
    (state / 'uploads/persistence-probe').write_text('retained')
    manage('stop')
    run(['bash', str(state / 'start.sh')])
    smoke()
    # Real redeployment, including existing secret preservation and old JWT use.
    run(setup + image_args)
    smoke()
    assert (state / 'uploads/persistence-probe').read_text() == 'retained'
    assert hashlib.sha256((state / 'settings.json').read_bytes()).hexdigest() == before
    manage('stop')
    # Foreground operation remains in the allocation and handles TERM gracefully.
    foreground = subprocess.Popen(['bash', str(state / 'start.sh'), '--foreground'], env=env)
    try:
        deadline = time.monotonic() + 120
        while not (state / 'run/ready.json').exists():
            assert foreground.poll() is None, 'Foreground startup exited'
            assert time.monotonic() < deadline, 'Foreground readiness timeout'
            time.sleep(.5)
        smoke()
        foreground.terminate()
        assert foreground.wait(timeout=150) == 0
    finally:
        if foreground.poll() is None:
            foreground.terminate()
            foreground.wait(timeout=150)
    print('Enroot installation, private listeners, account/session persistence, redeployment, and foreground shutdown passed.')
except Exception:
    # Surface actionable diagnostics through the public Actions check annotation.
    logs = sorted((state / 'logs').glob('*.log'), key=lambda p: (p.name == 'bootstrap.log', p.name))
    for log in logs:
        print(str(log), flush=True)
        lines = log.read_text(errors='replace').splitlines()[-(12 if log.name == 'bootstrap.log' else 3):]
        print('\n'.join(line[:300] for line in lines), flush=True)
    raise
finally:
    if (state / 'raftprod').exists():
        manage('stop')
