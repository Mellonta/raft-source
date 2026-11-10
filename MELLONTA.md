# Deploying self-hosted Raft on Linux

Use a checkout of this branch for all commands. The server is based on Raft
1.21.23. The Computer release pin in `scripts/mellonta/client-version` is
independent of the server version. Both Linux x86-64 and ARM64 are supported.
Run these scripts with Bash. Installation or publication of the corresponding
release is a separate operation from editing the source.

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
