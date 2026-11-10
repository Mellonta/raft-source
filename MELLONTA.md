# Deploying self-hosted Raft on Linux

Use a checkout of this branch for all commands. The server is based on Raft
1.21.23. The Computer release pin in `scripts/mellonta/client-version` is
independent of the server version. Both Linux x86-64 and ARM64 are supported.
Run these scripts with Bash. Installation or publication of the corresponding
release is a separate operation from editing the source.

## Production server with Docker

On Linux, use the account that owns your deployment and can run `docker ps`.
The script builds images from this checkout using Docker Compose v2. Setup
uses sudo only to install missing host tools or create a state directory under
a protected parent. If you use a separate storage disk, mount it before deploying.

```bash
bash scripts/mellonta/deploy-prod.sh --url http://raft.company.example:8001
bash /data/.raft-prod/raftprod status
bash /data/.raft-prod/raftprod logs server
```

The default state directory is `/data/.raft-prod`. To store PostgreSQL, RisingWave, Redis,
uploads, settings, backups and launchers elsewhere, pass the exact directory:

```bash
bash scripts/mellonta/deploy-prod.sh --state-dir /srv/raft --url http://raft.company.example:8001
bash /srv/raft/start.sh
bash /srv/raft/raftprod restart
```

The saved launchers remember their directory. For example, run
`bash /srv/raft/raftprod deploy` to rebuild after source changes, or
`bash /srv/raft/raftprod restart` to reload `server-extra.env`.
For direct calls to `deploy-prod.sh`, all commands accept `--state-dir` or
the environment variable `RAFT_PROD_STATE_DIR`. The flag takes precedence.
The default directory uses the existing Compose project `raft-prod`. A different
directory gets a separate project. To reuse existing data, select its directory.

Deployment backs up existing data, migrates PostgreSQL and verifies the portal
on the published port. An explicit HTTP port in `--url` becomes the listener
port. For a bare HTTP hostname, pass `--port 80` to serve it directly. A fresh
installation otherwise uses port 8080. For HTTPS, point your TLS reverse proxy at the listener and use
`--bind 127.0.0.1 --port PORT` for a local backend.

For a portal served over HTTP on a LAN hostname, open
`chrome://flags/#unsafely-treat-insecure-origin-as-secure` on each computer
that will use the portal in Chrome. Enter the exact origin from the address
bar (for example, `http://raft.company.example:8001`), enable the flag and
relaunch Chrome. This enables the browser's native crypto and clipboard APIs
for that origin. The HTTP connection remains unencrypted. A portal served
over trusted HTTPS needs no Chrome flag.

## Connect a Computer

Install your agent runtime separately. Use the Linux account that owns its
credentials. From the matching checkout, or using the version-pinned
`setup-client.sh` attached to a client release, run:

```bash
bash scripts/mellonta/setup-client.sh --server-url http://raft.company.example:8001 --workspace /my-team
```

The installer selects x86-64 or ARM64, checks the fork's binary and Photon WASM,
then runs the device login and attaches the machine. No system-wide Node or npm
is required. Use `--install-only` to defer login. Defaults are `~/.slock` for
state and `~/.local/bin` for a fresh binary. The shell launchers under
`~/.slock/mellonta/` use the selected state, release source and privacy setting.
Run `bash ~/.slock/mellonta/start.sh` or `bash ~/.slock/mellonta/raft-computer status`.
For an upgrade rerun setup with `--version X.Y.Z-mellonta.N` or run the saved
Computer wrapper with `upgrade --target-version X.Y.Z-mellonta.N`.
`--reset` explicitly erases the selected Computer state. A normal reinstall
retains it. The matching release must exist before online setup can fetch it. For a local
build, pass `--assets /tmp/raft-computer-release` to the same setup command.

## Privacy and persistence

Mellonta launchers default to `RAFT_PRIVACY_MODE=1`. Set
`RAFT_PRIVACY_MODE=0` in the server's preserved `server-extra.env` to select
normal operation, restart and reload the portal. On a Computer use the same
environment setting when running setup or the saved launcher. For an externally
managed service set it in the service definition. Check the server at
`/api/privacy-mode`. Installation contacts package registries or the fork's
GitHub Releases. The runtime controls are described in [README.md](README.md).

PostgreSQL holds the authoritative data. A single RisingWave 2.8.0 container
replicates the published PostgreSQL tables and maintains the upstream inbox,
activity and unread views. Its catalog and streaming data live under
`risingwave/` in the state directory. It has a private Docker network, no
published port and telemetry disabled.

### Upgrade an existing Docker installation

From the new checkout, run this during a maintenance window against the
**same state directory** that the old release used.

```bash
bash scripts/mellonta/deploy-prod.sh --state-dir /data/.raft-prod
```

The script reuses the saved URL, credentials and mounts. It builds the images
before stopping the portal and API, then saves a PostgreSQL dump, uploads and
the previous configuration under `backups/`. It enables logical replication,
runs the schema migrations and waits for the initial RisingWave snapshot and
views before serving traffic. Backfill time and additional disk space depend on
your message history. If setup stops, read the last error, correct it and rerun
the same command. Completed views and the replication slot survive a retry.
Keep the old checkout and pre-upgrade backup together for rollback. A rollback
to the old schema requires restoring that backup.

## Computer build and release

Build each Computer target on its own Linux architecture with Ubuntu 22.04 or
newer. Install the Node version in `.node-version` and the pnpm version in the
root `package.json`.

```bash
bash scripts/mellonta/build-client.sh /tmp/raft-computer-release
```

The release workflow builds both architectures, tests each installer and merges
the verified artifacts into one client release. The portal uses the same
version pin for its Linux setup command. Pushing a tag matching
`scripts/mellonta/client-version` publishes the release after both builds pass.
