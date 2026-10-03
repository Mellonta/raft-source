# Mellonta's self-hosted Raft Computer

This fork builds Raft Computer and its bundled daemon/agent CLI from the same
public source snapshot as Raft server 1.13.0 (`v1.13.0-source.1`). Computer and
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

## Install or replace the upstream client

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

## Build and publish another Linux release

Use Node from `.node-version` and pnpm 10.29.3. Bump the Computer package version
to the next `1.0.28-mellonta.N`, update these installation notes, commit, and push
a tag exactly matching that version. The `Mellonta Linux release` workflow tests
the privacy/update policy, builds the executable and manifest, smoke-tests the
installer on Ubuntu, then publishes the assets. One release covers Linux x64
machines; ARM64 and other operating systems need separate builds.

The original FSL-1.1-ALv2 license and copyright notice are preserved in `LICENSE`.
This is an independently modified distribution, not an official Botiverse release.
