# Mellonta's self-hosted Raft Computer

This fork builds Raft Computer and its bundled daemon/agent CLI from the same
public source snapshot as Raft server 1.21.0 (`v1.21.0-source.1`). Computer and
server have independent version numbers. This release is for Linux x86-64
(Ubuntu 22.04 or newer), with Node embedded; Node, npm and pnpm are not required
on the machine where you install it. Your agent runtime is still installed separately.

## Changes

- Disable Raft-managed MCP discovery, proxy registration, and injection into
  Claude Code and other agent runtimes. Existing user/enterprise MCP settings
  are left alone. Raft's local credential proxy and messaging CLI still work.
- Disable daemon trace-bundle uploads, session-transcript uploads, and Computer
  diagnostics uploads in the build, including forced/manual diagnostics pushes.
  Local logs remain available. This does not disable traffic to your Raft server
  or the model providers you use.
- Default update lookups use this fork's GitHub Releases, not Botiverse's CDN
  or Hands. Explicit environment overrides can still choose another update source.

## Updating from the 1.13 fork

This integration preserves the existing fork history and release tags. The
client version is now **1.0.43-mellonta.1**, based on upstream Computer 1.0.43;
server images are still identified separately by `enroot-server-<commit>`.

Upstream replaced its K updater with a separately downloaded Hands installer.
This fork keeps a Linux installer in `scripts/mellonta/install-client.sh` and
verifies its release checksum before a local upgrade. Run the saved client
wrapper with `upgrade --target-version 1.0.43-mellonta.1`, or rerun
`setup-client.sh` without `--reset` to retain credentials and workspaces.
The installer verifies binary and WASM files before stopping Computer, updates
the saved version pin, and restarts a previously running service.

**Portal-triggered remote upgrades are disabled** in this distribution because
upstream's remote completion protocol belongs to its external installer. Use
the local command above. The portal's installer commands and server version
recommendations still refer to upstream; use the Mellonta setup script below.
The new `channel versions` command is also upstream discovery; the fork's
published versions are on GitHub Releases. No upstream installer is executed.

The production Docker and Enroot images use Node 24.21 and the new oxc loader.
Enroot setup still needs no sudo or Docker on the cluster and keeps all state
under `~/park`. Upstream now requires RisingWave but omits its bootstrap SQL from the public
snapshot. Mellonta deployments explicitly select `RAFT_READ_BACKEND=postgres`:
Activity, sidebar unread, followed threads, and agent inbox/recovery use the
canonical PostgreSQL implementations retained in upstream's reference suite.
No extra database service is needed. This runs queries at read time instead of
using RisingWave's continuously maintained views, so large workspaces can use
more PostgreSQL CPU. Configured RisingWave installations retain upstream behavior;
there is no automatic fallback after a read failure.

## Install or replace the upstream client

For guided setup on each Linux x86-64 client machine, run as the account that
will run agents. First create your account and workspace in your own portal.
Install and authenticate the agent runtime (Claude Code, Codex, etc.) separately.
The client includes Node; it does not need Node, npm, Docker, or a source checkout.

```bash
curl -fsSL https://raw.githubusercontent.com/Mellonta/raft-source/main/scripts/mellonta/setup-client.sh -o /tmp/raft-setup-client.sh
bash /tmp/raft-setup-client.sh --server-url http://a.b.com:8080 --workspace YOUR_SLUG --home "$HOME/.slock" --reset
```

Replace `YOUR_SLUG` with the workspace slug in your portal URL, not its UUID.
`--home` must name the home of the old client you want to replace. The upstream
portal command may have used `$HOME/.raft-computer-YOUR_SLUG` instead of `.slock`.
If it installed a binary in that home's `bin` directory, setup detects it;
otherwise the default is `~/.local/bin`. `--install-dir PATH` overrides this.
Without `--home`, setup uses `RAFT_HOME`, then `SLOCK_HOME`, then `~/.slock`.

**`--reset` deletes all data in that one client home**, including credentials,
attachments, agent workspaces, local logs, and updater archives. It stops the
old Computer, installs verified release files, checks that Computer has stopped,
then erases state. It keeps no backup and performs no migration. Other client
homes and provider credentials outside that home are untouched. Omit `--reset`
to keep existing attachments and credentials. Active agent sessions are interrupted.

Setup resolves the latest published **Mellonta GitHub release**, displays its
version, verifies the installer checksum, and uses the release installer to
verify the executable and WASM. `--version X.Y.Z-mellonta.N` selects an exact
release. The installed version is pinned; rerun setup to install a newer release.
New deployment-script commits do not require a new Computer binary release.

Setup then runs interactive login, workspace attachment, and startup. Open the
printed login URL on your Mac and approve the device in your own portal. In a
non-interactive session, add `--install-only`, then run `connect.sh` in a terminal.
For the `.slock` home in the example, subsequent commands are:

```bash
bash "$HOME/.slock/mellonta/connect.sh"       # Login/attach if setup was install-only
bash "$HOME/.slock/mellonta/start.sh"         # One-line startup
bash "$HOME/.slock/mellonta/raft-computer" status
bash "$HOME/.slock/mellonta/raft-computer" restart
bash "$HOME/.slock/mellonta/raft-computer" stop
```

These launchers save the state path, binary path, and fork update source without
editing `.bashrc`. Use them to avoid another upstream binary or stale environment
settings. Computer logs are in `<home>/computer/run/service.log`. If using a
source checkout, the same script is `scripts/mellonta/setup-client.sh`.

### Install only with the release's lower-level installer

Run as the same Linux user that runs your current Computer. Preserve your current
`RAFT_HOME` / `SLOCK_HOME` if you use a custom data directory. The installer uses
`~/.local/bin` by default, verifies checksums, includes the required WASM resource,
and archives old K updater state before replacing it. A running Computer is
stopped and restarted, so active agent sessions may be interrupted.

```bash
curl -fL https://github.com/Mellonta/raft-source/releases/latest/download/install.sh -o /tmp/raft-mellonta-install.sh
RAFT_COMPUTER_FORCE=1 sh /tmp/raft-mellonta-install.sh
~/.local/bin/raft-computer --version
```

`RAFT_COMPUTER_FORCE=1` permits switching from upstream 1.0.40 to this fork's
1.0.28-mellonta.1. It does not bypass checksum verification. Fresh installations
can omit it. Set `RAFT_COMPUTER_INSTALL_DIR` if your existing binary is installed
elsewhere. Ensure that this binary is first on PATH, and restart existing agent
sessions after replacement so they receive the patched runtime configuration.

The installer pins the installed release by default. An existing pin is preserved;
use `raft-computer channel set pinned:1.0.28-mellonta.1` to change it to this release.
To opt into updates from this fork, use `raft-computer channel set latest`.
Remove any old `RAFT_COMPUTER_RELEASE_BACKEND=hands` or upstream
`RAFT_COMPUTER_UPGRADE_BASE_URL` override if you previously configured one.

## Access the raftdev portal through your hostname

Set the allowed hostnames when launching the server checkout:

```bash
VITE_DEV_ALLOWED_HOSTS=a.b.com ./raftdev start
```

For multiple hosts, use `VITE_DEV_ALLOWED_HOSTS=a.b.com,other.example.com`.
Use hostnames without `http://`, `https://`, ports, or paths. A leading dot, such
as `.example.com`, also allows subdomains. The setting reaches the web process
even when tmux is already running; an unset or empty value clears a stale list.
The built-in local and tunnel hosts remain allowed. The same variable works
with `pnpm --filter @botiverse/raft-web dev` and `preview`.

The value is read when the web process starts. Setting it in another shell
does not change an already-running process. This is a server checkout setting;
updating the Computer binary is not required.

## Enroot server setup without sudo

For a cluster account with Enroot already installed, use the Enroot production
deployment. All host files default to `~/park`; this setup never invokes sudo,
apt, Docker, or systemd on the cluster. It needs Linux x86-64, Python 3.9+, and a
working Enroot 3.5+ installation. Git is needed only to obtain this checkout.

```bash
mkdir -p "$HOME/park"
git clone https://github.com/Mellonta/raft-source.git "$HOME/park/raft"
bash "$HOME/park/raft/scripts/mellonta/setup-enroot.sh" --url http://a.b.com:8080
```

Use your actual portal origin in `--url`. If the fork checkout already exists,
update it with `git -C "$HOME/park/raft" pull --ff-only` instead of cloning again.
There is no host nvm/Node/npm installation: the verified image contains Node,
the Raft API, the production web build, nginx, PostgreSQL 16, and Redis. The
frontend uses the portal's own origin, so changing the URL needs no web rebuild.
The image runs as your ordinary host user, without Enroot root remapping.

Setup downloads the latest **Enroot server** release, verifies its SHA-256,
extracts it, generates private settings, initializes/migrates the database, and
waits for the portal to become healthy. `--release enroot-server-COMMIT` pins an
exact published build. `--image /path/raft-server-linux-x64.sqsh --manifest
/path/enroot-manifest.json` installs previously downloaded artifacts offline.
Server images have separate releases and do not change the Computer installer's
`releases/latest` pointer or require a new Computer version.

| Path | Contents |
| --- | --- |
| `~/park/raft` | Fork checkout and deployment tools |
| `~/park/.raft-prod/settings.json` | Saved public URL, ports, and generated secrets |
| `~/park/.raft-prod/postgres`, `redis`, `uploads` | Persistent database, cache, and uploaded files |
| `~/park/.raft-prod/server-extra.env` | Optional API environment, such as email delivery settings |
| `~/park/.raft-prod/logs` | Service logs, rotated at 10 MiB with three retained rotations |
| `~/park/.raft-prod/images` | Verified SquashFS downloads |
| `~/park/.raft-prod/backups` | Database/files/settings snapshots before changing the migration revision |
| `~/park/.enroot` | Extracted container filesystems, Enroot cache, runtime files, and temporary files |

`--root PATH` changes the `~/park` root. The directory must be writable by your
user, persistent between jobs, and on storage suitable for PostgreSQL (including
working file locks). Enroot mount paths cannot contain whitespace or colons.
This creates a fresh deployment; it does not import or erase old `/data` or
raftdev state. Preserve `settings.json` with the database: setup will not silently
regenerate credentials if a database exists without its settings.

After setup, start with one command:

```bash
bash "$HOME/park/.raft-prod/start.sh"
```

Other commands use the saved state and image:

```bash
bash "$HOME/park/.raft-prod/raftprod" status
bash "$HOME/park/.raft-prod/raftprod" logs                 # API logs, including email links
bash "$HOME/park/.raft-prod/raftprod" logs --service migrate
bash "$HOME/park/.raft-prod/raftprod" restart
bash "$HOME/park/.raft-prod/raftprod" stop
```

Run setup again to download a newer image. It finishes downloading/extracting
before stopping the previous instance. Secrets, database files, and uploads are
retained. Startup runs journaled migrations on a changed image revision, making
a backup if the database already exists. Failed initialization/migrations leave
the service stopped; logs explain the failure. The supervisor shuts all services
down if one fails; use `restart` after resolving the failure. It does not install
an automatic boot service. Old images remain available under `.enroot/data` and
`.raft-prod/images`; setup does not erase them or roll back database migrations.

For a scheduler allocation, keep the supervisor in the foreground:

```bash
bash "$HOME/park/.raft-prod/start.sh" --foreground
```

To prepare files before submitting a job, add `--no-start` to setup; the first
`start.sh --foreground` inside the allocation initializes the database. Enroot
does not extend a Slurm time limit or make a compute node reachable outside the
cluster. Run on a node/allocation where persistent services are permitted. Only
one instance may use a given data directory at a time.

Enroot shares host networking. The portal listens on `0.0.0.0:8080` by default;
`--bind 127.0.0.1` is suitable for a local TLS proxy or SSH tunnel. PostgreSQL,
Redis, the API, and metrics listen on loopback. PostgreSQL and Redis require
generated passwords. All five ports are configurable to avoid conflicts on
shared nodes: `--port 8080 --api-port 3001 --metrics-port 9090 --postgres-port
5432 --redis-port 6379`. A configured public URL must include the appropriate
portal port unless an existing reverse proxy provides it. No certificates or
cluster firewall changes are installed.

Register your account and workspace in the portal, then connect your separately
installed Computer client. Without email delivery configuration, verification
links appear in the API logs. Continue to use this fork's client setup script;
the portal's upstream CDN installation link has not been replaced.

The `Mellonta Enroot server release` workflow builds images in CI, tests actual
unprivileged Enroot deployment with host sudo/Docker/apt commands blocked, checks
account/session and file persistence, then publishes the image and manifest.
Docker and sudo are used only to prepare the disposable CI builder.

## Ubuntu server setup with Docker (development)

With the data disk mounted at `/data` and Docker already working for your Linux
account, run the setup script as that account. It uses sudo only for missing apt
packages and creating directories; it does not configure, migrate, restart, or
reinstall Docker, or change Docker group membership. Your existing `/dockerroot`
configuration is retained.

```bash
bash scripts/mellonta/setup-ubuntu.sh --allowed-hosts a.b.com
```

The script can also run from a downloaded copy outside the checkout: it clones
the public fork to `/data/raft` if necessary. It reuses existing nvm, or installs
[nvm v0.40.8](https://github.com/nvm-sh/nvm/tree/v0.40.8) in `/data/.nvm`; selects
Node from `.node-version` (npm is included); installs the pinned pnpm and missing
Ubuntu tools; and installs server, web, and daemon dependencies. It starts
`raftdev` unless `--no-start` is passed. AI provider CLIs and credentials are
configured separately.

| Path | Contents |
| --- | --- |
| `/data/raft` | Source, dependencies, and build outputs |
| `/data/.raftdev/<name>` | PostgreSQL, Redis, object storage, launcher state, local traces |
| `/data/.raftdev/.dev-env-<name>.json` | Seed credentials |
| `/data/.raft` | Daemon/agent state and workspaces |
| `/data/.raft-config` | Runtime settings and launch scripts |
| `/data/.nvm` | Newly installed nvm, Node, npm, and pnpm |
| `/data/.npm`, `/data/.pnpm`, `/data/.pnpm-store`, `/data/.cache`, `/data/.tmp` | Package caches, Vite cache, and temporary files |

After setup, the one-line startup command is:

```bash
bash /data/.raft-config/start.sh
```

The default environment name is `raft`; `--name NAME` selects another name at
setup. Use the generated launcher for other commands so they use the same state:
`bash /data/.raft-config/raftdev status` or `bash /data/.raft-config/raftdev logs raft`.
Launch-time `VITE_DEV_ALLOWED_HOSTS` overrides the saved default. Change other
defaults in `/data/.raft-config/settings.sh`; setup preserves that file on reruns.
New setup defaults disable public tunnels, trace worker/collector services,
artificial latency, and idle auto-stop. The web portal still runs in dev mode.

PostgreSQL, Redis, and object storage use persistent bind mounts under `/data`.
Stopping the dev environment removes its containers and seed credentials but
retains those data directories. Rerunning setup leaves an existing tmux session
running and reports status. It does not silently migrate in-checkout state or
reuse containers mounted to a different data location; those require a deliberate
data migration. Existing source is retained unless `--update` is supplied, which
allows only a clean fast-forward of `main`.

## Production server deployment with Docker

For the production web build and an API without a development watcher, run from
the updated fork checkout on your Linux server:

```bash
bash scripts/mellonta/deploy-prod.sh --url http://a.b.com:8080
```

Replace the URL with the exact origin your Mac and Computer clients will use.
The script uses your existing Docker daemon and Compose v2 plugin. Node and pnpm
are installed inside the build images; no host Node installation is needed.
It retains an existing `/data/raft` checkout or clones the fork there. Updating
source remains explicit: pull your changes before rerunning `deploy-prod.sh`.

The frontend is built with Vite's production build and served by nginx, including
API and WebSocket proxying. The server uses the upstream Docker runtime approach:
Node with `tsx` loading TypeScript once, without `watch`; the server package's
`tsc` configuration does not emit a standalone JavaScript build. Both run with
production settings. This deployment does not use `raftdev` or tmux.

By default nginx publishes HTTP on all interfaces at port 8080. `--port` changes
the port; for a direct HTTP URL, include that port in `--url` as appropriate.
For an existing local TLS reverse proxy, forward to `127.0.0.1:8080`, including
WebSocket upgrades and `X-Forwarded-Proto`, then deploy with:

```bash
bash scripts/mellonta/deploy-prod.sh --url https://a.b.com --bind 127.0.0.1
```

The script does not provision TLS certificates. `--url` and the saved settings
are baked into the web build; rerun deployment to change them.

All application data is separate from dev state:

| Path | Contents |
| --- | --- |
| `/data/.raft-prod/postgres` | Production PostgreSQL data |
| `/data/.raft-prod/redis` | Redis append-only persistence |
| `/data/.raft-prod/uploads` | Attachments and other stored files, using Raft's local disk backend |
| `/data/.raft-prod/settings.json` | Generated secrets and public URL/port configuration; preserve this file |
| `/data/.raft-prod/server-extra.env` | Optional server settings such as email delivery credentials |
| `/data/.raft-prod/backups` | Database dumps plus files/config snapshots taken before migrations |

PostgreSQL, Redis, and the API are accessible inside the Compose network; only
nginx publishes a host port. Containers restart after a Docker restart unless
you explicitly stopped them. Logs use Docker's rotated local log storage.

Builds finish before the previous application is stopped. Deployment then takes
a database dump and uploads/config archive, applies the repository's journaled
migrations with its production preflight, and waits for database/API/web health.
It never runs dev seeding or `drizzle-kit push --force`. A migration failure leaves
the app stopped and the backup available; no automatic database rollback occurs.
Backups are on the same disk, so copy them elsewhere if you need disk-failure recovery.

Subsequent commands are:

```bash
bash /data/.raft-prod/start.sh
bash /data/.raft-prod/raftprod restart
bash /data/.raft-prod/raftprod status
bash /data/.raft-prod/raftprod logs
bash /data/.raft-prod/raftprod stop
```

`restart` reloads `server-extra.env`; `deploy` rebuilds and migrates. `logs` follows
server logs; append `web`, `postgres`, or `redis` to select another service.
Register your account in the portal. Without `RESEND_API_KEY`, verification emails
are printed in server logs; alternatively configure email delivery in
`server-extra.env` and restart. No default test account is created.

This is a fresh production database. Existing raftdev data is not automatically
converted or copied, and raftdev keeps running until you stop it. Agent execution
still uses your separately installed custom Computer client; use this fork's
GitHub installer above, because the portal's install command still points upstream.
Web analytics, web trace uploads, and server trace exports are off by default in
these images; this is not a guarantee of zero outbound network traffic.

## Build and publish another Linux release

Use Node from `.node-version` and pnpm 10.29.3. Bump the Computer package version
to the next `1.0.28-mellonta.N`, update these installation notes, commit, and push
a tag exactly matching that version. The `Mellonta Linux release` workflow tests
the privacy/update policy, builds the executable and manifest, smoke-tests the
installer on Ubuntu, then publishes the assets. One release covers Linux x64
machines; ARM64 and other operating systems need separate builds.

The original FSL-1.1-ALv2 license and copyright notice are preserved in `LICENSE`.
This is an independently modified distribution, not an official Botiverse release.
