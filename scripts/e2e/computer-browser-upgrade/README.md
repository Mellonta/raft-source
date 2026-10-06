# Staging Computer browser-upgrade harness

This directory contains the repeatable execution components for the staging
Linux Computer browser-upgrade acceptance path documented in
[`docs/operations/hands-k-three-os-e2e.md`](../../../docs/operations/hands-k-three-os-e2e.md).

The harness is deliberately split across authority boundaries:

- `staging-api.mjs` logs in through the fixed staging origins, creates a normal
  Computer attachment, reads staging state, and deletes only an attachment
  whose identity matches the run's pre-upgrade receipt.
- `prepare-computer-attachment.sh` installs one attachment into an isolated
  `RAFT_HOME` and starts an exact old Computer binary without printing its key.
- `browser-preflight.mjs` proves that the selected server's Computers page is
  usable and not covered by a setup projection.
- `browser-upgrade.mjs` observes or clicks the exact target-version product
  control and writes a secret-free browser receipt even on failure.
- `run-upgrade-e2e.mjs` executes the browser driver, validates independently
  collected post-upgrade evidence, and coordinates fail-closed cleanup.

This is not a lifecycle evidence collector. A successful browser response,
visible success text, API result, or CLI version does not independently prove a
completed upgrade. The run can pass only after a separate privileged reader
provides the bound post-upgrade evidence described below.

## Safety boundary

Use only an authorized staging QA organization and a disposable TestBed VM.
Never point the scripts at production or a user-owned machine. The API and UI
origins are fixed in source. Credential, session, attachment, SSH, and raw
readback files are private inputs and must remain mode `0600`; do not commit,
attach, or print them.

`run-upgrade-e2e.mjs` authorizes destructive cleanup only after both bindings
match:

1. attachment ↔ server/machine/linked-Computer IDs in the pre-upgrade receipt;
2. pre-upgrade receipt ↔ bed ID/revision, SSH host, remote root, and exact
   `/tmp/task809.*` secret directory supplied to the run.

A binding failure starts no subprocess, performs no network request or cleanup,
and preserves the secret directory for recovery. The secret directory is
permanently removed only after machine deletion/absence, preservation of the
recorded starting inventory, old Computer credential revocation, TestBed
tombstone, and zero-residue readback are all proved. Output receipts must live
outside the secret directory.

The `upgrade` browser mode is a real product action: it can download, install,
and run another Computer binary. Obtain any action-time confirmation required
by the browser operator before invoking it. `observe` and preflight modes do not
click the control.

## Inputs and command flow

Run commands from the repository root. Install the repository's frozen
dependencies first so `playwright` is available.

```bash
HARNESS=scripts/e2e/computer-browser-upgrade

node "$HARNESS/staging-api.mjs" login \
  /tmp/task809.RUN/qa-account.json \
  /tmp/task809.RUN/staging-session.json

TASK809_PLAYWRIGHT_ROOT="$PWD" node "$HARNESS/browser-preflight.mjs" \
  --session /tmp/task809.RUN/staging-session.json \
  --server-slug SERVER_SLUG \
  --server-id SERVER_UUID \
  --out-dir artifacts/computer-browser-upgrade/RUN/preflight

node "$HARNESS/staging-api.mjs" attach \
  /tmp/task809.RUN/staging-session.json \
  SERVER_SLUG UNIQUE_MACHINE_NAME \
  /tmp/task809.RUN/attachment.json

node "$HARNESS/staging-api.mjs" attachment-payload \
  /tmp/task809.RUN/attachment.json \
  https://api-aws-staging.botiverse.dev \
  /tmp/task809.RUN/runner-attachment.json
```

Copy `prepare-computer-attachment.sh`, the exact old binary, and
`runner-attachment.json` to the disposable VM using a secret-safe file transfer.
Run the preparation script there with absolute paths. Then create the
pre-upgrade receipt only after independently reading the exact identities,
starting inventory, concrete service/runner PIDs, and execution-resource
binding.

The pre-upgrade receipt has this shape. The execution values must describe the
same disposable resource passed to the orchestrator; `secretDir` is the exact
private run directory, not a parent or glob.

```json
{
  "schema": "raft.task809.pre-upgrade.v1",
  "server": {
    "id": "11111111-1111-4111-8111-111111111111",
    "slug": "fixture-server"
  },
  "machine": { "id": "33333333-3333-4333-8333-333333333333" },
  "linkedComputer": { "id": "22222222-2222-4222-8222-222222222222" },
  "preExistingMachineIds": [],
  "processes": { "servicePid": 100, "runnerPid": 101 },
  "execution": {
    "bedId": "55555555-5555-4555-8555-555555555555",
    "bedRevision": 2,
    "sshHost": "raft-tb-deadbeef.exe.xyz",
    "remoteRoot": "/home/exedev/task809-deadbeef",
    "secretDir": "/tmp/task809.RUN"
  }
}
```

The orchestrator's full invocation is intentionally explicit:

```bash
node "$HARNESS/run-upgrade-e2e.mjs" \
  --qa-account /tmp/task809.RUN/qa-account.json \
  --session /tmp/task809.RUN/staging-session.json \
  --attachment /tmp/task809.RUN/attachment.json \
  --pre-upgrade /tmp/task809.RUN/pre-upgrade.json \
  --post-upgrade /tmp/task809.RUN/post-upgrade.json \
  --bed-id 55555555-5555-4555-8555-555555555555 \
  --bed-revision 2 \
  --ssh-host raft-tb-deadbeef.exe.xyz \
  --ssh-key /tmp/task809.RUN/id_ed25519 \
  --known-hosts /tmp/task809.RUN/known_hosts \
  --remote-root /home/exedev/task809-deadbeef \
  --playwright-root "$PWD" \
  --target-version 1.0.32 \
  --post-upgrade-timeout-ms 300000 \
  --secret-dir /tmp/task809.RUN \
  --out-dir artifacts/computer-browser-upgrade/RUN
```

Use `--cleanup-only true` with the same complete binding to abandon an unclicked
or failed run safely. It intentionally exits nonzero with
`cleanup_only_no_upgrade` while still producing the cleanup receipt.

## External post-upgrade evidence contract

After the browser action is accepted, the orchestrator atomically writes
`post-upgrade-evidence-request.json` in `--out-dir`. The independent reader
must wait for that request before collecting evidence. The request binds the
exact operation, three resource identities, target version, output path,
request ID, and deadline. The orchestrator waits for up to
`--post-upgrade-timeout-ms` (default five minutes, maximum fifteen minutes)
before failing and entering cleanup; it does not destroy the VM immediately
just because the evidence file was not already present.

The reader must include the request's `evidenceRequestId` and `operationId` in
the evidence, write the complete JSON to a temporary sibling on the same
filesystem, and atomically rename that sibling to the request's
`postUpgradePath`. For example:

```bash
REQUEST=artifacts/computer-browser-upgrade/RUN/post-upgrade-evidence-request.json
POST_UPGRADE=$(node -e 'const r=require(process.argv[1]); process.stdout.write(r.postUpgradePath)' "$REQUEST")
TMP="${POST_UPGRADE}.tmp.$$"
# The independent reader writes the complete bound document to "$TMP".
mv "$TMP" "$POST_UPGRADE"
```

The final `--post-upgrade` document must use
`evidenceContract: "externally-collected-bound-readbacks.v1"`. It must bind the
same three identities and target version, record concrete replacement PIDs and
the VM binary SHA-256, and contain the browser operation ID plus ordered
timestamps:

```json
{
  "schema": "raft.task809.post-upgrade.v1",
  "evidenceContract": "externally-collected-bound-readbacks.v1",
  "evidenceRequestId": "77777777-7777-4777-8777-777777777777",
  "serverId": "SERVER_UUID",
  "machineId": "MACHINE_UUID",
  "serverMachineId": "LINKED_COMPUTER_UUID",
  "targetVersion": "1.0.32",
  "machineStatus": "online",
  "serverComputerVersion": "1.0.32",
  "vmBinaryVersion": "1.0.32",
  "vmBinarySha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "processes": { "servicePid": 120, "runnerPid": 121 },
  "lifecycle": {
    "operationId": "66666666-6666-4666-8666-666666666666",
    "targetVersion": "1.0.32",
    "shutdownAckAt": "2026-09-17T12:00:01.000Z",
    "disconnectedAt": "2026-09-17T12:00:02.000Z",
    "readyAckAt": "2026-09-17T12:00:03.000Z",
    "terminalAt": "2026-09-17T12:00:04.000Z",
    "loadedComputerVersion": "1.0.32",
    "terminalStatus": "succeeded"
  }
}
```

The validator starts the ordering window at the browser receipt's
`actionStartedAt`, not the later HTTP-response observation. It computes process
replacement by comparing these PIDs with the pre-upgrade receipt; a caller
boolean cannot stand in for the readback. An explicitly empty
`preExistingMachineIds` list is valid, but an absent field or unrecognized
machine-list response shape is not treated as an empty list.

## Regression test

```bash
pnpm test:computer-browser-upgrade
```

The committed tests invoke normal mode (not a validation-only shortcut) for
four cases. Identity and execution-resource mismatches must exit with zero
subprocesses, every cleanup action false, and the secret sentinel preserved. A
late evidence file must be accepted only after the operation-bound request and
atomic rename; a missing evidence file must time out and still complete every
cleanup action. They use no network or shared service.
