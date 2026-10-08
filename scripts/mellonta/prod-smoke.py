#!/usr/bin/env python3
"""CI smoke against the actual built deployment (no user credentials)."""
import base64
import http.client
import json
import os
from pathlib import Path
import re
import secrets
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from urllib.parse import urlsplit

origin = os.environ.get("RAFT_SMOKE_ORIGIN", "http://127.0.0.1:8080")
with urlopen(origin + "/health") as response:
    assert json.load(response)["status"] == "ok"
with urlopen(origin + "/") as response:
    html = response.read().decode()
    assert response.headers["X-Frame-Options"] == "DENY"
    assert "frame-ancestors 'none'" in response.headers["Content-Security-Policy"]
assert "/@vite/client" not in html and "react-refresh" not in html
assets = re.findall(r'(?:src|href)="(/assets/[^\"]+)"', html)
assert assets, "Built JS/CSS assets are missing"
for asset in assets:
    with urlopen(origin + asset) as response:
        assert "immutable" in ",".join(response.headers.get_all("Cache-Control"))
        assert response.read()
with urlopen(origin + "/desktop-manifest.json") as response:
    assert response.headers["ETag"].startswith('"sha256-')
    assert isinstance(json.load(response), dict)
address = urlsplit(origin)
connection = http.client.HTTPConnection(address.hostname, address.port or 80, timeout=10)
connection.request("GET", "/socket.io/?EIO=4&transport=websocket", headers={
    "Connection": "Upgrade", "Upgrade": "websocket", "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": base64.b64encode(os.urandom(16)).decode(),
    "Origin": origin,
})
assert connection.getresponse().status == 101, "WebSocket upgrade failed"
connection.close()

# These routes live outside /api. They must reach the server, not the SPA or
# nginx's dotfile deny rule. Signing keys are optional in a fresh deployment.
for path in ("/.well-known/openid-configuration", "/oidc/deploy-smoke/.well-known/openid-configuration"):
    try:
        with urlopen(origin + path) as response:
            document = json.load(response)
            assert document["authorization_endpoint"].startswith(origin + "/"), document
    except HTTPError as error:
        assert error.code == 503 and json.load(error)["error"] == "oidc_not_configured", path

for path in ("/.env", "/.git/config"):
    try:
        urlopen(origin + path)
        raise AssertionError(f"Private path exposed: {path}")
    except HTTPError as error:
        assert error.code in (403, 404), path

# On the disposable CI runner, verify real account/session tables as well as
# health's SELECT 1. Reuse the account and old JWT after stop/start/redeployment.
if os.environ.get("GITHUB_ACTIONS") == "true":
    saved = Path(os.environ["RUNNER_TEMP"]) / "raft-production-test-account.json"

    def api(path, body=None, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        request = Request(origin + "/api/auth/" + path, headers=headers,
                          data=json.dumps(body).encode() if body else None)
        with urlopen(request) as response:
            return json.load(response)

    if saved.exists():
        account = json.loads(saved.read_text())
        assert api("me", token=account["token"])["email"] == account["email"]
    else:
        account = {"email": f"deploy-{secrets.token_hex(6)}@example.invalid", "password": secrets.token_hex(24)}
        legal = (Path(__file__).parents[2] / "packages/shared/src/legalAcceptance.ts").read_text()
        registration = api("register", {
            **account, "acceptTerms": True, "__e2eAutoVerify": True,
            "termsVersion": re.search(r'CURRENT_TERMS_VERSION = "([^"]+)"', legal)[1],
            "privacyVersion": re.search(r'CURRENT_PRIVACY_VERSION = "([^"]+)"', legal)[1],
        })
        account["token"] = registration["accessToken"]
        # Raft 1.21 defers identity setup until after registration. Complete the
        # same onboarding step as the portal before calling workspace routes.
        api("me/complete-profile", {
            "name": "deploy" + secrets.token_hex(6), "displayName": "Deployment smoke",
        }, token=account["token"])
        saved.write_text(json.dumps(account))
        saved.chmod(0o600)
    login = api("login", {"email": account["email"], "password": account["password"]})
    assert login["accessToken"]

    # Exercise real PostgreSQL-backed Activity/sidebar/followed-thread routes.
    # A green /health alone missed upstream's new hard RisingWave dependency.
    def workspace_api(path, body=None):
        headers = {"Content-Type": "application/json", "Authorization": "Bearer " + account["token"]}
        if account.get("workspace"):
            headers["X-Server-Id"] = account["workspace"]
        request = Request(origin + "/api/" + path, headers=headers,
                          data=json.dumps(body).encode() if body is not None else None)
        try:
            with urlopen(request) as response:
                return json.load(response)
        except HTTPError as error:
            raise AssertionError(f"{path}: HTTP {error.code}: {error.read(2048).decode(errors='replace')}") from error

    if not account.get("workspace"):
        workspace = workspace_api("servers", {"name": "Deployment smoke", "slug": "deploy-" + secrets.token_hex(6)})
        account["workspace"] = workspace["id"]
        saved.write_text(json.dumps(account))
    for path in ("channels/inbox", "channels/unread?summary=1", "channels/threads/followed", "servers/unread-summary"):
        assert workspace_api(path) is not None, path
print("Production health, assets, manifest, WebSocket, and CI authentication checks passed.")
