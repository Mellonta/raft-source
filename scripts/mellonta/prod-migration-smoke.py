"""Rehearse an upgrade with two users and real messages on a disposable CI deployment."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import UUID, uuid4

temporary = Path(os.environ["RUNNER_TEMP"])
account = json.loads((temporary / "raft-production-test-account.json").read_text())
fixture = temporary / "raft-upgrade-fixture.json"
origin = os.environ["RAFT_SMOKE_ORIGIN"]
state = Path(os.environ["TEST_STATE_DIR"])
workspace = UUID(account["workspace"])


def api(path, token, body=None):
    request = Request(origin + "/api/" + path, headers={
        "Authorization": "Bearer " + token, "X-Server-Id": str(workspace), "Content-Type": "application/json",
    }, data=json.dumps(body).encode() if body is not None else None)
    try:
        with urlopen(request, timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError(f"{path}: {error.code} {error.read(512).decode()}") from error


def unread(channel, token, expected):
    for _ in range(40):
        rows = api("channels/unread?summary=1", token)["channels"]
        actual = rows.get(channel, {}).get("unreadCount", 0)
        if actual == expected:
            return
        time.sleep(0.5)
    raise AssertionError(f"Channel unread count: expected {expected}, got {actual}")


def send(channel, text):
    return api("v2/messages", account["token"], {"channelId": channel, "content": text})["message"]


if sys.argv[1] == "seed":
    reader = uuid4()
    owner = UUID(api("auth/me", account["token"])["id"])
    email = f"reader-{reader}@example.invalid"
    # Give the second disposable account the same test password and a workspace membership.
    subprocess.run(["docker", "compose", "--env-file", "/dev/null", "-f", str(state / "compose.json"),
                    "exec", "-T", "postgres", "psql", "-U", "raft", "-d", "raft", "-v", "ON_ERROR_STOP=1"],
                   input=f"""
                   BEGIN;
                   INSERT INTO users (id, email, name, password_hash, email_verified)
                       SELECT '{reader}', '{email}', 'reader{reader.hex[:12]}', password_hash, true FROM users WHERE id = '{owner}';
                   INSERT INTO server_members (server_id, user_id) VALUES ('{workspace}', '{reader}');
                   UPDATE users SET signup_survey_completed_at = now(), first_onboarding_completed_at = now()
                       WHERE id IN ('{owner}', '{reader}');
                   UPDATE server_members SET setup_status = 'complete', setup_completion_reason = 'grandfathered' WHERE server_id = '{workspace}';
                   COMMIT;
                   """, text=True, check=True)
    # Legacy prod-smoke saves only the 15-minute access token. Exercise real
    # renewable sessions even when a build and backfill take longer than that.
    owner_session = api("auth/login", "", {"email": account["email"], "password": account["password"]})
    account.update(token=owner_session["accessToken"], refreshToken=owner_session["refreshToken"])
    (temporary / "raft-production-test-account.json").write_text(json.dumps(account))
    reader_session = api("auth/login", "", {"email": email, "password": account["password"]})
    token = reader_session["accessToken"]
    channel = api("channels/dm", account["token"], {"userId": str(reader)})["id"]
    message = send(channel, "History from the old production release")
    unread(channel, token, 1)
    with fixture.open("x") as out:
        fixture.chmod(0o600)
        json.dump({"channel": channel, "refreshToken": reader_session["refreshToken"], "message": message["id"]}, out)
    (state / "uploads" / "upgrade-probe").write_bytes(b"old deployment file")
    print("Old deployment has a DM with one unread message.")
else:
    saved = json.loads(fixture.read_text())
    channel = saved["channel"]
    session = api("auth/refresh", "", {"refreshToken": saved["refreshToken"]})
    token = session["accessToken"]
    saved["refreshToken"] = session["refreshToken"]
    fixture.write_text(json.dumps(saved))
    assert (state / "uploads" / "upgrade-probe").read_bytes() == b"old deployment file"
    history = api("messages/channel/" + channel, token)
    messages = history if isinstance(history, list) else history["messages"]
    assert any(row["id"] == saved["message"] and row["content"] == "History from the old production release" for row in messages)
    if sys.argv[1] == "verify":
        unread(channel, token, 1)
        latest = send(channel, "Live replication after upgrade")
        unread(channel, token, 2)
        api(f"channels/{channel}/read", token, {"seq": latest["seq"]})
    elif sys.argv[1] != "recheck":
        raise SystemExit("Expected seed, verify or recheck")
    unread(channel, token, 0)
    print("Verified old session, message identity and content, upload, and unread state.")
