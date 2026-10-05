#!/usr/bin/env python3
import argparse
import base64
import hashlib
import importlib.util
import json
import os
import socket
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


control = load('control', 'enroot-control.py')
runtime = load('runtime', 'enroot-runtime.py')


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def args(self, **values):
        return argparse.Namespace(public_url='http://raft.example:8080', **values)

    def test_secrets_and_optional_environment_survive_reconfiguration(self):
        settings = control.configure(self.root, self.args())
        control.write(self.root / 'settings.json', json.dumps(settings))
        changed = control.configure(self.root, argparse.Namespace(public_url='https://raft.example', port=18080))
        for key in ['postgres_password', 'redis_password', 'jwt_secret', 'bootstrap_pepper', 'mcp_key']:
            self.assertEqual(settings[key], changed[key])
        self.assertEqual(len(base64.b64decode(changed['mcp_key'])), 32)
        self.assertEqual(changed['port'], 18080)
        self.assertEqual((self.root / 'settings.json').stat().st_mode & 0o777, 0o600)

    def test_rejects_colliding_or_privileged_ports_and_invalid_origins(self):
        for values in [{'port': 80}, {'api_port': 8080}, {'redis_port': 70000}, {'bind': '0.0.0.0;bad'}]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                control.configure(self.root, self.args(**values))
        for url in ['http://user:password@host', 'https://host/path', 'file:///tmp/test', 'http://host:99999']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                control.configure(self.root, argparse.Namespace(public_url=url))

    def test_never_regenerates_secrets_for_an_existing_database(self):
        (self.root / 'postgres').mkdir()
        (self.root / 'postgres/PG_VERSION').write_text('16')
        with self.assertRaisesRegex(ValueError, 'without settings'):
            control.configure(self.root, self.args())

    def test_environment_file_is_data_not_shell_code(self):
        env = self.root / 'server-extra.env'
        env.write_text('# comment\nFROM_EMAIL="Raft <me@example.test>"\nVALUE=$(touch /not-executed)\n')
        self.assertEqual(runtime.extra_environment(env), {'FROM_EMAIL': 'Raft <me@example.test>', 'VALUE': '$(touch /not-executed)'})
        env.write_text('export KEY=value\n')
        with self.assertRaises(ValueError):
            runtime.extra_environment(env)

    def test_image_must_match_manifest_before_cache_activation(self):
        image = self.root / control.IMAGE_NAME
        image.write_bytes(b'test-image')
        manifest = self.root / 'manifest.json'
        metadata = {'schema': 1, 'image': image.name, 'commit': 'a' * 40, 'sha256': '0' * 64}
        manifest.write_text(json.dumps(metadata))
        args = argparse.Namespace(image=image, manifest=manifest)
        cache = self.root / 'images'
        with self.assertRaisesRegex(ValueError, 'checksum'):
            control.get_image(args, cache)
        self.assertEqual(list(cache.iterdir()), [])
        metadata['sha256'] = hashlib.sha256(image.read_bytes()).hexdigest()
        manifest.write_text(json.dumps(metadata))
        target, actual = control.get_image(args, cache)
        self.assertEqual(target.read_bytes(), image.read_bytes())
        self.assertEqual(actual, metadata)

    def test_server_release_selection_ignores_the_computer_latest_release(self):
        sha = 'b' * 40
        metadata = {'schema': 1, 'image': control.IMAGE_NAME, 'commit': sha,
                    'sha256': hashlib.sha256(b'cached').hexdigest()}
        cache = self.root / 'images'
        cache.mkdir()
        (cache / (sha + '.sqsh')).write_bytes(b'cached')
        releases = [{'draft': False, 'tag_name': '1.0.28-mellonta.1'},
                    {'draft': False, 'tag_name': control.RELEASE_PREFIX + sha}]
        with patch.object(control, 'request_json', side_effect=[releases, metadata]):
            target, _ = control.get_image(argparse.Namespace(image=None, release=None), cache)
        self.assertEqual(target.name, sha + '.sqsh')

    @unittest.skipUnless(Path('/proc/self/stat').exists(), 'Linux /proc identity test')
    def test_reused_pid_does_not_receive_a_stop_signal(self):
        (self.root / 'run').mkdir()
        record = control.process_identity(os.getpid())
        record['ticks'] = '0'
        (self.root / 'run/runtime.json').write_text(json.dumps(record))
        with patch.object(control.os, 'kill') as kill:
            control.stop(self.root)
            kill.assert_not_called()

    def test_port_preflight_rejects_listeners_but_accepts_recently_closed_connections(self):
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
            listener.listen()
            with self.assertRaises(OSError):
                control.probe_port('127.0.0.1', port)
            with socket.create_connection(('127.0.0.1', port)) as client:
                connection, _ = listener.accept()
                with connection:
                    connection.shutdown(socket.SHUT_WR)
                    self.assertEqual(client.recv(1), b'')
        control.probe_port('127.0.0.1', port)


if __name__ == '__main__':
    unittest.main()
