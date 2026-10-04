#!/usr/bin/env python3
"""CI smoke against the actual built deployment (no user credentials)."""
import base64
import http.client
import json
import os
import re
from urllib.request import urlopen

origin = "http://127.0.0.1:8080"
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
connection = http.client.HTTPConnection("127.0.0.1", 8080, timeout=10)
connection.request("GET", "/socket.io/?EIO=4&transport=websocket", headers={
    "Connection": "Upgrade", "Upgrade": "websocket", "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": base64.b64encode(os.urandom(16)).decode(),
    "Origin": origin,
})
assert connection.getresponse().status == 101, "WebSocket upgrade failed"
connection.close()
print("Production health, static assets, manifest, and WebSocket checks passed.")
