#!/usr/bin/env python3
import argparse
import base64
from contextlib import redirect_stderr
import hashlib
import importlib.util
import io
import json
import os
import socket
from pathlib import Path
import tempfile
import tarfile
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


control = load('control', 'native-control.py')
runtime = load('runtime', 'native-runtime.py')


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        machine = patch.object(control.platform, 'machine', return_value='x86_64')
        machine.start()
        self.addCleanup(machine.stop)

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

    def test_http_url_port_is_inferred_unless_a_proxy_port_is_explicit(self):
        for values, expected in [({'public_url': 'http://raft.example:8001'}, 8001),
                                 ({'public_url': 'http://raft.example:8001', 'port': 18080}, 18080),
                                 ({'public_url': 'https://raft.example:8443'}, 8080)]:
            with self.subTest(values=values):
                self.assertEqual(control.configure(self.root, argparse.Namespace(**values))['port'], expected)
        original = control.configure(self.root, argparse.Namespace(public_url='http://raft.example:8001', port=8080))
        control.write(self.root / 'settings.json', json.dumps(original))
        corrected = control.configure(self.root, argparse.Namespace(public_url='http://raft.example:8001'))
        self.assertEqual(corrected['port'], 8001)
        self.assertEqual(corrected['jwt_secret'], original['jwt_secret'])

    def test_environment_file_is_data_not_shell_code(self):
        env = self.root / 'server-extra.env'
        env.write_text('# comment\nFROM_EMAIL="Raft <me@example.test>"\nVALUE=$(touch /not-executed)\n')
        self.assertEqual(runtime.extra_environment(env), {'FROM_EMAIL': 'Raft <me@example.test>', 'VALUE': '$(touch /not-executed)'})
        env.write_text('export KEY=value\n')
        with self.assertRaises(ValueError):
            runtime.extra_environment(env)

    def test_image_must_match_manifest_before_cache_activation(self):
        image = self.root / 'raft-server-linux-x64.tar.gz'
        image.write_bytes(b'test-image')
        manifest = self.root / 'manifest.json'
        metadata = {'schema': 1, 'bundle': image.name, 'platform': 'linux-x64', 'commit': 'a' * 40, 'sha256': '0' * 64}
        manifest.write_text(json.dumps(metadata))
        args = argparse.Namespace(bundle=image, manifest=manifest)
        cache = self.root / 'images'
        with self.assertRaisesRegex(ValueError, 'checksum'):
            control.get_bundle(args, cache)
        self.assertEqual(list(cache.iterdir()), [])
        metadata['sha256'] = hashlib.sha256(image.read_bytes()).hexdigest()
        manifest.write_text(json.dumps(metadata))
        target, actual = control.get_bundle(args, cache)
        self.assertEqual(target.read_bytes(), image.read_bytes())
        self.assertEqual(actual, metadata)

    def test_server_release_selection_ignores_the_computer_latest_release(self):
        sha = 'b' * 40
        metadata = {'schema': 1, 'bundle': 'raft-server-linux-x64.tar.gz', 'platform': 'linux-x64', 'commit': sha,
                    'sha256': hashlib.sha256(b'cached').hexdigest()}
        cache = self.root / 'images'
        cache.mkdir()
        (cache / (sha + '-linux-x64.tar.gz')).write_bytes(b'cached')
        releases = [{'draft': False, 'tag_name': '1.0.28-mellonta.1'},
                    {'draft': False, 'tag_name': control.RELEASE_PREFIX + sha}]
        with patch.object(control, 'request_json', side_effect=[releases, metadata]):
            target, _ = control.get_bundle(argparse.Namespace(bundle=None, release=None), cache)
        self.assertEqual(target.name, sha + '-linux-x64.tar.gz')

    def test_streamed_download_reports_before_network_io_and_never_caches_a_partial_transfer(self):
        data = b'bundle' * 200_000
        sha = 'f' * 40
        metadata = {'schema': 1, 'bundle': 'raft-server-linux-x64.tar.gz', 'platform': 'linux-x64',
                    'commit': sha, 'sha256': hashlib.sha256(data).hexdigest()}
        for length in [None, len(data), len(data) + 1]:
            with self.subTest(length=length), tempfile.TemporaryDirectory(dir=self.root) as folder:
                cache = Path(folder)
                output = io.StringIO()
                response = io.BytesIO(data)
                response.headers = {} if length is None else {'Content-Length': str(length)}

                def connect(*args, **kwargs):
                    self.assertIn('Downloading raft-server-linux-x64.tar.gz', output.getvalue())
                    return response

                with redirect_stderr(output), patch.object(control, 'request_json', return_value=metadata), \
                        patch.object(control, 'urlopen', side_effect=connect):
                    args = argparse.Namespace(bundle=None, release=control.RELEASE_PREFIX + sha)
                    if length == len(data) + 1:
                        with self.assertRaisesRegex(ValueError, 'Incomplete bundle download'):
                            control.get_bundle(args, cache)
                        self.assertEqual(list(cache.iterdir()), [])
                    else:
                        target, _ = control.get_bundle(args, cache)
                        self.assertEqual(target.read_bytes(), data)
                        self.assertIn('MiB', output.getvalue())
                        self.assertIn('Verifying bundle SHA-256', output.getvalue())
                        if length is not None:
                            self.assertIn('(100%)', output.getvalue())

    def test_arm_uses_its_manifest_and_distinct_image_cache(self):
        sha = 'c' * 40
        metadata = {'schema': 1, 'bundle': 'raft-server-linux-arm64.tar.gz', 'platform': 'linux-arm64',
                    'commit': sha, 'sha256': hashlib.sha256(b'arm-image').hexdigest()}
        cache = self.root / 'images'
        cache.mkdir()
        (cache / (sha + '-linux-arm64.tar.gz')).write_bytes(b'arm-image')
        with patch.object(control.platform, 'machine', return_value='aarch64'), \
                patch.object(control, 'request_json', return_value=metadata) as request:
            target, _ = control.get_bundle(argparse.Namespace(bundle=None, release=control.RELEASE_PREFIX + sha), cache)
            self.assertTrue(request.call_args.args[0].endswith('/server-manifest-linux-arm64.json'))
            self.assertEqual(target.read_bytes(), b'arm-image')
            self.assertEqual(target.name, sha + '-linux-arm64.tar.gz')

    def test_wrong_architecture_is_rejected_even_with_a_matching_checksum(self):
        image = self.root / 'raft-server-linux-x64.tar.gz'
        image.write_bytes(b'x64-image')
        manifest = self.root / 'manifest.json'
        manifest.write_text(json.dumps({'schema': 1, 'bundle': image.name, 'platform': 'linux-x64',
                                       'commit': 'a' * 40, 'sha256': hashlib.sha256(image.read_bytes()).hexdigest()}))
        with patch.object(control.platform, 'machine', return_value='aarch64'), self.assertRaisesRegex(ValueError, 'architecture mismatch'):
            control.get_bundle(argparse.Namespace(bundle=image, manifest=manifest), self.root / 'images')
        self.assertFalse((self.root / 'images').exists())

    def test_supported_architecture_aliases(self):
        for machine, expected in [('x86_64', 'linux-x64'), ('amd64', 'linux-x64'),
                                  ('aarch64', 'linux-arm64'), ('arm64', 'linux-arm64')]:
            with patch.object(control.platform, 'machine', return_value=machine):
                self.assertEqual(control.linux_target(), expected)
        with patch.object(control.platform, 'machine', return_value='armv7l'), self.assertRaisesRegex(ValueError, 'ARM64'):
            control.linux_target()

    def test_extraction_rejects_traversal_and_escaping_symlinks(self):
        for name, link in [('../escape', None), ('/absolute', None), ('link', '../../escape')]:
            archive = self.root / 'unsafe.tar.gz'
            with tarfile.open(archive, 'w:gz') as stream:
                member = tarfile.TarInfo(name)
                if link:
                    member.type = tarfile.SYMTYPE
                    member.linkname = link
                stream.addfile(member)
            with self.subTest(name=name), self.assertRaises(ValueError):
                control.extract_archive(archive, self.root / 'extract')
        self.assertFalse((self.root / 'escape').exists())

    def test_extraction_preserves_internal_relative_package_links(self):
        archive = self.root / 'safe.tar.gz'
        with tarfile.open(archive, 'w:gz') as stream:
            data = tarfile.TarInfo('app/packages/example')
            data.size = 3
            stream.addfile(data, io.BytesIO(b'ok!'))
            link = tarfile.TarInfo('app/node_modules/example')
            link.type = tarfile.SYMTYPE
            link.linkname = '../packages/example'
            stream.addfile(link)
        control.extract_archive(archive, self.root / 'extract')
        self.assertEqual((self.root / 'extract/app/node_modules/example').read_bytes(), b'ok!')

    def test_prefix_relocation_runs_at_the_final_path_and_completed_bundles_are_reused(self):
        runtime_archive = self.root / 'runtime.tar.gz'
        with tarfile.open(runtime_archive, 'w:gz'):
            pass
        revision = self.root / 'revision'
        revision.write_text('d' * 40)
        archive = self.root / 'bundle.tar.gz'
        with tarfile.open(archive, 'w:gz') as stream:
            stream.add(runtime_archive, arcname='runtime.tar.gz')
            stream.add(revision, arcname='revision')
        manifest = {'commit': 'd' * 40, 'platform': 'linux-x64', 'sha256': 'e' * 64}
        with patch.object(control.subprocess, 'run') as run:
            target = control.prepare_bundle(archive, manifest, self.root / 'releases')
            self.assertEqual(run.call_args.args[0], [str(target / 'runtime/bin/python'), str(target / 'runtime/bin/conda-unpack')])
            self.assertEqual((target / '.ready').read_text().strip(), manifest['sha256'])
            self.assertEqual(control.prepare_bundle(archive, manifest, self.root / 'releases'), target)
            self.assertEqual(run.call_count, 1)

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
