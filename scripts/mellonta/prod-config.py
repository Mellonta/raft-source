#!/usr/bin/env python3
"""Generate a private, persistent Compose deployment; no shell-evaluated config."""
import argparse
import base64
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import subprocess
from urllib.parse import urlsplit


def write_private(path, text):
    temporary = path.with_suffix(path.suffix + ".tmp")
    with open(temporary, "w", opener=lambda p, f: os.open(p, f, 0o600)) as file:
        file.write(text)
    temporary.chmod(0o600)
    temporary.replace(path)


def configure(source, root, public_url=None, port=None, bind=None, *, output=None):
    root = root.resolve()
    source = source.resolve()
    output = output or root
    # Keep existing default installations on their original project and image names.
    suffix = "" if root == Path("/data/.raft-prod").resolve() else "-" + hashlib.sha256(os.fsencode(root)).hexdigest()[:12]
    settings_file = root / "settings.json"
    if settings_file.exists():
        settings = json.loads(settings_file.read_text())
    else:
        if any((root / "postgres").iterdir()):
            raise ValueError("Existing PostgreSQL data has no settings.json; restore its original secrets first.")
        settings = {
            "public_url": None, "port": 8080, "bind": "0.0.0.0",
            "postgres_password": secrets.token_hex(32),
            "jwt_secret": secrets.token_hex(32),
            "bootstrap_pepper": secrets.token_hex(32),
            "mcp_key": base64.b64encode(secrets.token_bytes(32)).decode(),
        }
    for key, value in [("public_url", public_url), ("port", port), ("bind", bind)]:
        if value is not None:
            settings[key] = value
    url = urlsplit(settings["public_url"] or "")
    if (url.scheme not in ("http", "https") or not url.hostname
            or url.username or url.password or url.path not in ("", "/")
            or url.query or url.fragment or re.search(r"[\s$'\"\\]", settings["public_url"])):
        raise ValueError("First deployment requires --url with a public HTTP(S) origin, e.g. http://a.b.com:8080")
    # A direct HTTP origin's explicit port is the default published port.
    # --port still allows a different internal port behind a reverse proxy;
    # HTTPS origins leave that proxy-facing port unchanged.
    url_port = url.port  # Also rejects malformed/out-of-range ports.
    if public_url is not None and port is None and url.scheme == "http" and url_port is not None:
        settings["port"] = url_port
    settings["public_url"] = settings["public_url"].rstrip("/")
    if not 1 <= int(settings["port"]) <= 65535:
        raise ValueError("--port must be between 1 and 65535")
    ipaddress.ip_address(settings["bind"])
    for key in ("postgres_password", "jwt_secret", "bootstrap_pepper"):
        if not re.fullmatch(r"[0-9a-f]{64}", settings[key]):
            raise ValueError(f"Invalid saved {key}; restore settings.json instead of rotating credentials")
    if len(base64.b64decode(settings["mcp_key"], validate=True)) != 32:
        raise ValueError("Invalid saved MCP encryption key")
    node_version = (source / ".node-version").read_text().strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", node_version):
        raise ValueError("Invalid repository Node version")
    revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    extra_env = root / "server-extra.env"
    if not extra_env.exists():
        write_private(extra_env, "# Optional server settings, preserved by deploy. No shell syntax.\n"
                      "# RAFT_PRIVACY_MODE=0 to enable normal upstream behavior.\n# RESEND_API_KEY=...\n# FROM_EMAIL=Raft <you@example.com>\n")
    database_url = f"postgresql://raft:{settings['postgres_password']}@postgres:5432/raft"
    environment = {
        "NODE_ENV": "production", "DEPLOYMENT_ENV": "production", "PORT": "3001",
        "DATABASE_URL": database_url, "RISINGWAVE_DATABASE_URL": "postgresql://root@risingwave:4566/dev",
        "REDIS_URL": "redis://redis:6379",
        "JWT_SECRET": settings["jwt_secret"], "AGENT_BOOTSTRAP_TOKEN_PEPPER": settings["bootstrap_pepper"],
        "SLOCK_MCP_CREDENTIAL_KEY": settings["mcp_key"],
        "SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED": "true",
        "SERVER_URL": settings["public_url"], "APP_URL": settings["public_url"],
        "CORS_ORIGIN": settings["public_url"], "UPLOADS_DIR": "/var/lib/raft/uploads",
        "UPLOADS_LOCAL": "true",
        "RAFT_RELEASE_SHA": revision, "SLOCK_RELEASE_SHA": revision,
    }
    logging = {"driver": "local", "options": {"max-size": "10m", "max-file": "3"}}
    common = {"restart": "unless-stopped", "logging": logging}
    build = {"context": str(source), "dockerfile": "scripts/mellonta/prod.Dockerfile",
             "args": {"NODE_VERSION": node_version, "RELEASE_SHA": revision}}

    def mount(name, target):
        return {"type": "bind", "source": str(root / name), "target": target,
                "bind": {"create_host_path": False}}

    def health(command, start="15s"):
        return {"test": command, "interval": "5s", "timeout": "4s", "retries": 30, "start_period": start}

    server = {
        **common, "image": f"mellonta-raft-server{suffix}:local", "build": {**build, "target": "server"},
        "init": True, "user": f"{os.getuid()}:{os.getgid()}", "env_file": [str(extra_env)],
        "environment": environment, "volumes": [mount("uploads", "/var/lib/raft/uploads")],
        "networks": ["default", "reads"],
        "depends_on": {name: {"condition": "service_healthy"} for name in ("postgres", "redis", "risingwave")},
        "healthcheck": health(["CMD", "node", "-e", "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], "60s"),
        "stop_grace_period": "40s",
    }
    compose = {"name": "raft-prod" + suffix, "networks": {"default": {}, "reads": {"internal": True}}, "services": {
        "postgres": {**common, "image": "postgres:16-alpine", "networks": ["reads"],
                     "command": ["postgres", "-c", "wal_level=logical"],
                     "environment": {"POSTGRES_USER": "raft", "POSTGRES_DB": "raft", "POSTGRES_PASSWORD": settings["postgres_password"]},
                     "volumes": [mount("postgres", "/var/lib/postgresql/data")],
                     "healthcheck": health(["CMD", "pg_isready", "-U", "raft", "-d", "raft"])},
        "risingwave": {**common, "networks": ["reads"],
                       # Upstream 2.8.0 multi-architecture image (linux/amd64 and linux/arm64).
                       "image": "risingwavelabs/risingwave@sha256:ba5915a5e85c938a3ec62d76c63c6e4cb37d4f4e3c5c30886f0d2eff61b70073",
                       "command": ["single_node", "--store-directory", "/var/lib/risingwave",
                                   "--listen-addr", "0.0.0.0:4566", "--parallelism", "1"],
                       "environment": {"ENABLE_TELEMETRY": "false"},
                       "volumes": [mount("risingwave", "/var/lib/risingwave")],
                       "healthcheck": health(["CMD", "bash", "-c", "true > /dev/tcp/127.0.0.1/4566"]),
                       "stop_grace_period": "60s"},
        "rw-bootstrap": {"image": server["image"], "profiles": ["tools"], "init": True, "networks": ["reads"],
                         "environment": {key: environment[key] for key in ("DATABASE_URL", "RISINGWAVE_DATABASE_URL")},
                         "command": ["node", "--import", "@oxc-node/core/register", "packages/server/scripts/mellonta-risingwave.ts"]},
        "redis": {**common, "image": "redis:7-alpine", "command": ["redis-server", "--appendonly", "yes"],
                  "volumes": [mount("redis", "/data")], "healthcheck": health(["CMD", "redis-cli", "ping"])},
        "server": server,
        "migrate": {"networks": ["reads"], "image": server["image"], "profiles": ["tools"], "init": True,
                    "environment": {**environment, "DATABASE_URL": database_url + "?options=-c%20statement_timeout%3D60000",
                                    "SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS": "60000"},
                    "command": ["pnpm", "--filter", "@botiverse/raft-server", "db:migrate:mellonta"]},
        "web": {**common, "image": f"mellonta-raft-web{suffix}:local", "build": {**build, "target": "web"},
                "ports": [{"target": 80, "published": str(settings["port"]), "host_ip": settings["bind"]}],
                "depends_on": {"server": {"condition": "service_healthy"}},
                "healthcheck": health(["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1/health"])},
    }}
    # Compose interpolates even JSON strings: keep paths/values literal.
    write_private(output / "compose.json", json.dumps(compose, indent=2).replace("$", "$$") + "\n")
    write_private(output / "settings.json", json.dumps(settings, indent=2) + "\n")
    launcher = shlex.quote(str(source / "scripts/mellonta/deploy-prod.sh"))
    launch = f'#!/usr/bin/env bash\nexport RAFT_PROD_STATE_DIR={shlex.quote(str(root))}\nexec bash {launcher}'
    write_private(output / "start.sh", f'{launch} start "$@"\n')
    write_private(output / "raftprod", f'{launch} "$@"\n')


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, help="Stage generated files here before installing them in --root")
    parser.add_argument("--url")
    parser.add_argument("--port", type=int)
    parser.add_argument("--bind")
    args = parser.parse_args()
    try:
        configure(args.source, args.root, args.url, args.port, args.bind, output=args.output)
    except (ValueError, KeyError) as error:
        parser.error(str(error))
