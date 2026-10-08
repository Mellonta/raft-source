import importlib.util
from email.message import Message
import io
import json
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('verify', Path(__file__).with_name('prod-verify.py'))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class ServedFrontendTests(unittest.TestCase):
    revision = 'a' * 40

    def responses(self, *, revision=None, script_type='application/javascript'):
        identity = json.dumps({'commitSha': revision or self.revision})
        html = f'<script id="raft-frontend-release-identity" type="application/json">{identity}</script><script type="module" src="/assets/app.js"></script>'
        def fetch(request, timeout):
            self.assertEqual(request.get_header('Cache-control'), 'no-cache')
            kind, body = ('text/html', html) if request.full_url.endswith('/') else (script_type, 'app()')
            response = io.BytesIO(body.encode())
            response.headers = Message()
            response.headers['Content-Type'] = kind
            return response
        return fetch

    def test_current_frontend_passes(self):
        verify.verify('http://127.0.0.1:8001', self.revision, self.responses())

    def test_stale_container_is_not_reported_as_successful_deployment(self):
        with self.assertRaisesRegex(RuntimeError, 'expected ' + self.revision):
            verify.verify('http://127.0.0.1:8001', self.revision, self.responses(revision='b' * 40))

    def test_spa_fallback_does_not_hide_a_missing_script(self):
        with self.assertRaisesRegex(RuntimeError, 'missing or served as text/html'):
            verify.verify('http://127.0.0.1:8001', self.revision, self.responses(script_type='text/html'))


if __name__ == '__main__':
    unittest.main()
