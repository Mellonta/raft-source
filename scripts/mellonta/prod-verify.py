#!/usr/bin/env python3
"""Verify the frontend actually served by Docker, not just the API health route."""
import argparse
from html.parser import HTMLParser
import ipaddress
import json
from pathlib import Path
from urllib.request import Request, urlopen


class FrontendDocument(HTMLParser):
    def __init__(self):
        super().__init__()
        self.identity = ''
        self.in_identity = False
        self.scripts = []

    def handle_starttag(self, tag, attributes):
        if tag != 'script':
            return
        attrs = dict(attributes)
        self.in_identity = attrs.get('id') == 'raft-frontend-release-identity'
        if attrs.get('src'):
            self.scripts.append(attrs['src'])

    def handle_data(self, text):
        if self.in_identity:
            self.identity += text

    def handle_endtag(self, tag):
        if tag == 'script':
            self.in_identity = False


def verify(origin, revision, fetch=urlopen):
    def get(path):
        with fetch(Request(origin + path, headers={'Cache-Control': 'no-cache'}), timeout=15) as response:
            return response.headers.get_content_type(), response.read().decode('utf-8')

    content_type, html = get('/')
    if content_type != 'text/html':
        raise RuntimeError('Portal returned ' + content_type + ' instead of HTML')
    document = FrontendDocument()
    document.feed(html)
    identity = json.loads(document.identity or '{}')
    actual = identity.get('commitSha')
    if actual != revision:
        raise RuntimeError(f'Portal serves frontend {actual!r}; expected {revision}. Deployment is not verified.')
    if not any(src.startswith('/assets/') for src in document.scripts):
        raise RuntimeError('Portal is missing the production application bundle')
    for src in document.scripts:
        if not src.startswith('/') or src.startswith('//'):
            raise RuntimeError('Unexpected frontend script URL: ' + src)
        kind, script = get(src)
        if kind not in ('application/javascript', 'text/javascript') or not script.strip():
            raise RuntimeError(f'Frontend script {src} is missing or served as {kind}')
    print(f'Frontend {revision[:12]} and its startup scripts verified at {origin}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--settings', type=Path, required=True)
    parser.add_argument('--revision', required=True)
    args = parser.parse_args()
    settings = json.loads(args.settings.read_text())
    address = ipaddress.ip_address(settings['bind'])
    host = ('::1' if address.version == 6 else '127.0.0.1') if address.is_unspecified else str(address)
    if address.version == 6:
        host = '[' + host + ']'
    verify(f"http://{host}:{settings['port']}", args.revision)


if __name__ == '__main__':
    main()
