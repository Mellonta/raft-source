# Deploying self-hosted Raft

Use a checkout of this branch for all commands. The server is based on Raft
1.33.1. The portal and checkout installer use the published Computer version
in `scripts/mellonta/prod-client-version`. The production server runs with Docker on
Linux and macOS. Raft Computer runs natively on Apple Silicon Macs and on
x86-64 and ARM64 Linux machines.
Run these scripts with Bash. Installation or publication of the corresponding
release is a separate operation from editing the source.

## Production server with Docker

Use the account that owns the deployment and can run `docker ps`. The script
uses Git, Python 3 and Docker Compose v2 to deploy from this checkout. On macOS,
start Docker Desktop and run the script directly in Terminal. These commands
deploy on localhost and show the status of each service.

```bash
bash scripts/mellonta/deploy-prod.sh --url http://localhost:8001 --bind 127.0.0.1
bash ~/.raft-prod/raftprod status
```

On Linux, the script uses sudo only to install missing host tools or create a
state directory under a protected parent. If you use a separate storage disk,
mount it before deploying.

```bash
bash scripts/mellonta/deploy-prod.sh --url http://raft.company.example:8001
bash /data/.raft-prod/raftprod status
bash /data/.raft-prod/raftprod logs server
```

The default state directory is `/data/.raft-prod` on Linux and `~/.raft-prod` on macOS.
Use `--state-dir` to keep PostgreSQL, RisingWave, Redis, uploads, settings,
backups and launchers in another directory.

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
The Linux default directory uses the existing Compose project `raft-prod`. Any other
directory gets a separate project. To reuse existing data, select its directory.

Each deploy assigns Founder to all active workspaces and sets it as the default
for new workspaces.

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

Install your agent runtime separately. Use the macOS or Linux account that owns
its credentials. From the matching checkout, or using the version-pinned
`setup-client.sh` attached to a client release, run:

```bash
bash scripts/mellonta/setup-client.sh --server-url http://raft.company.example:8001 --workspace /my-team
```

The installer selects the release for the host OS and CPU, checks the fork's
binary and Photon WASM, then runs device login and attaches the machine.
On macOS it also verifies the executable's code signature. No system-wide Node or npm
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
**same state directory** that the old release used. If you chose a custom
directory, pass it again with `--state-dir`. The saved `raftprod` launcher uses
the checkout that last deployed it.

```bash
bash scripts/mellonta/deploy-prod.sh
```

The script reuses the saved URL, credentials and mounts. It builds the images
and checks the effective agent encryption keys before stopping the portal and API.
It saves a PostgreSQL dump, uploads and the previous configuration under
`backups/`. It enables logical replication,
runs the schema migrations and waits for the initial RisingWave snapshot and
views before serving traffic. Backfill time and additional disk space depend on
your message history. If setup stops, read the last error, correct it and rerun
the same command. Completed views and the replication slot survive a retry.
When upgrading from 1.21.23 to 1.24, deployment resnapshots two RisingWave CDC
projections and rebuilds their dependent views from PostgreSQL while the API is stopped.

When upgrading from Mellonta `1.25.0-mellonta.2` (server `1.24.0`) to server
`1.33.1`, upstream removes saved provider connections and their stored keys.
Built-in agents that used a saved connection keep their model and other settings,
but need a new provider before they can run. Legacy Computers whose registrant
has left the workspace or become a guest can also have their keys revoked.
The deployment keeps an existing `SLOCK_PROVIDER_CREDENTIAL_KEY` from
`server-extra.env`. Otherwise it derives a stable default from the original
`settings.json`. Keep both files with the database.

### Roll back to the released server

Keep the old checkout and the backup path printed on the **first upgrade from
the old release**. A retry can produce a backup of an already migrated database.
Restoring the original backup returns data to the maintenance window. Writes
accepted afterward need separate recovery.

For the standard Mellonta Docker deployment, set `state` to the deployment's
absolute state directory and stop its Compose project
with `docker compose --env-file /dev/null -f "$state/compose.json" down`.
Move its whole state directory aside, keeping the backup, and recreate an empty
directory **at the original path**. The archived Compose file uses absolute bind
mounts. Set `backup` to the saved backup directory in its new location.
Run the following from the old checkout.

```bash
(
  set -eu
  umask 077
  mkdir -p "$state"/{postgres,redis,risingwave,backups}
  tar -xzf "$backup/files-and-config.tar.gz" -C "$state"
  compose=(docker compose --env-file /dev/null -f "$state/compose.json")
  "${compose[@]}" up -d --wait postgres
  "${compose[@]}" exec -T postgres pg_restore -U raft -d raft \
    --single-transaction --exit-on-error --no-acl < "$backup/database.dump"
  bash scripts/mellonta/deploy-prod.sh --state-dir "$state"
)
```

The database dump omits cluster roles. On a fresh standard cluster, `--no-acl`
lets the released deploy recreate its `raft_cdc` role and grants and rebuild
RisingWave from PostgreSQL. Installations with custom database roles or grants
should restore those roles first and restore the dump with its ACLs.

## Computer build and release

Build on the target architecture using an Apple Silicon Mac with the Xcode
Command Line Tools, or Ubuntu 22.04 or newer on x86-64 or ARM64. Use the
native Node version in `.node-version` and the pnpm version in the root
`package.json`.

```bash
bash scripts/mellonta/build-client.sh /tmp/raft-computer-release
```

To install the local build before publishing, run:

```bash
bash scripts/mellonta/setup-client.sh --assets /tmp/raft-computer-release --server-url http://raft.company.example:8001 --workspace /my-team
```

The macOS build uses an ad-hoc code signature. The fork release workflow does
not apply an Apple Developer ID signature or submit the executable for notarization.
The workflow tests all three native targets and combines their artifacts into
one release.
Pushing a tag matching `scripts/mellonta/client-version` publishes the release
after all three builds pass. Once its assets are available, update
`scripts/mellonta/prod-client-version` to offer that release to new installations.
