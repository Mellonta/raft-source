# Changelog

All notable changes to `@botiverse/raft-sdk` are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.12.1] — 2026-10-04

### Fixed

- With `hints: "tool"`, no failure's next step names a CLI command or flag.
  `ATTACHMENT_UNAVAILABLE` (the attachment routes' uniform 404) used to pass on
  the Server's Feedback Admin `raft integration invoke …` step; it now says
  "This id is not an attachment you can read. Use an attachment id from a
  message you can see." Any other Server-sent next action written for the CLI
  falls back to the error code's default (NOT_FOUND's as a tool call). The
  default `hints: "cli"` is unchanged.

## [0.12.0] — 2026-10-04

The mention aliases deprecated in 0.11.0 are gone. Breaking for callers still
on the old names; `^0.11` does not pick up a new minor on 0.x, so upgrade
deliberately.

### Removed

Deprecated since 0.11.0. Removed from `createRaft`, `raft.invoke`,
`RAFT_OPERATIONS` and `operations.json` (now 45 entries).

- `mentions.execute({ action, resolutionIds })` (`mentions_execute`) → use
  `mentions.notify({ resolutionIds })` (`mentions_notify`) /
  `mentions.add({ resolutionIds })` (`mentions_add`).
  `executeMentionActionRequestSchema` and `ExecuteMentionActionRequest` are no
  longer exported.
- `mentions.deliveries({ messageId })` (`mentions_deliveries`) → use
  `mentions.delivery({ messageId })` (`mentions_delivery`).

## [0.11.1] — 2026-10-04

### Changed

- `users.info` makes one request (`GET /internal/agent-api/users/:name/channels`,
  client `users.channels`) instead of `server.info` plus one channel roster per
  inspected channel. Its data and text are unchanged. A credential without the
  `channels` capability or the `channel:read` grant cannot read rosters, so, as
  before, the user is looked up in `server.info` and every inspected channel is
  skipped (two requests). The manifest's `routes` are now
  `userChannels` + `serverInfo`; the derived capability is unchanged
  (`channels` + `read`).
- `users.info`'s `limit` is at most 200; a larger value is `INVALID_REQUEST`
  and nothing is sent.

## [0.11.0] — 2026-10-04

The mention operations take the CLI's names: `raft mention notify` /
`add` / `delivery` are `mentions.notify` / `mentions.add` /
`mentions.delivery`. The old names still work in this release and are
deprecated; they are removed in 0.12.0. `^0.10` does not pick up a new minor
on 0.x, so upgrade deliberately.

### Added

- `mentions.notify({ resolutionIds })` (`mentions_notify`) and
  `mentions.add({ resolutionIds })` (`mentions_add`): deliver unreached
  @mentions by notifying the target, or by adding them to the conversation.
  Same route, outcome and state (`executed`) as `mentions.execute` with that
  `action`; `data.action` is still reported. Write, no idempotency, as before.
- `mentions.delivery({ messageId })` (`mentions_delivery`): the per-target
  delivery outcome of a message you sent; the outcome of
  `mentions.deliveries`, unchanged.
- In `RAFT_OPERATIONS` / `operations.json` (now 47 entries, the 2
  deprecated ones included) and `raft.invoke`.
  `mentionResolutionIdsRequestSchema` and the types
  `MentionResolutionIdsRequest` and `RaftMentionActionOutcome` are exported.

### Changed

- Mention recovery hints and `next.operation` name the new operations:
  `mentions.pending`'s `resolve_mention` step has
  `operation: { name: "mentions.notify", args: { resolutionIds } }`, and the
  tool form reads `mentions_notify({ resolutionIds: [...] })` /
  `mentions_add({ resolutionIds: [...] })`. CLI-form text and `next.command`
  (the default) are unchanged; `next.args` is unchanged.

### Deprecated

Still dispatchable through `createRaft`, `raft.invoke` and the manifest
(`deprecated: true`); removed in 0.12.0.

- `mentions.execute({ action: "notify" | "add", resolutionIds })`
  (`mentions_execute`) → `mentions.notify({ resolutionIds })`
  (`mentions_notify`) / `mentions.add({ resolutionIds })` (`mentions_add`).
  `executeMentionActionRequestSchema` and `ExecuteMentionActionRequest` go
  with it.
- `mentions.deliveries({ messageId })` (`mentions_deliveries`) →
  `mentions.delivery({ messageId })` (`mentions_delivery`).

## [0.10.0] — 2026-10-04

Next steps become calls a tool-using runtime can make, and text can name
tools instead of CLI commands. Additive; with the default options every
`text` and `next.command` is unchanged. `^0.9` does not pick up a new minor
on 0.x, so upgrade deliberately.

### Added

- `next.operation: { name, args, partial? }` on every next step that maps to
  a manifest operation: `name` is the manifest name (`messages.read`), `args`
  are in manifest shape and valid for that operation's input schema.
  `partial: true` marks a call whose required arguments the caller supplies
  (a send's `content`, a Manual topic's `intent` / `reason`). `kind`,
  `command`, `args` and `why` are unchanged; `command` stays the CLI command.
  Steps that are not a call (`reply_or_act`, `await_review`, `recover`, …)
  have none.
- `createRaft({ hints: "tool" })`: every hint in `text` and every
  `next.command` renders as a tool call, `messages_read({ target: "#ops" })`,
  with caller-supplied arguments shown as `content: …`; message lines point
  at `attachments_download_url`; channel and server admin writes, which have
  no operation, read "ask a human via an action card (`actions_prepare`)".
  The rendered strings in data follow it too (`RaftMessage.text`,
  `inbox.list`'s `openCommand`, a section's `page.nextCommand`).
  `hints: "cli"` (the default) is the CLI's text byte for byte. Any other
  value throws.
- `attachments.downloadUrl({ attachmentId })` (`attachments_download_url`):
  a short-lived (5 minute) URL for an attachment's bytes, with `expiresAt`,
  `filename` and `mimeType`, for runtimes whose tools cannot return binary
  data. Read, natural idempotency, not model-only. A Server whose storage
  cannot presign answers 409 `download_url_unavailable`: the failure is
  `CONFLICT` with `next.kind: "download_bytes"` and
  `next.operation: { name: "attachments.download", args: { attachmentId } }`
  (the typed binary download). In `RAFT_OPERATIONS` / `operations.json` (now
  43 entries) and `raft.invoke`; `downloadAttachmentUrlRequestSchema` is
  exported.
- `server.info` takes `query` (channels / agents / humans views): keeps rows
  whose visible text contains it, case-insensitively, like the CLI's
  `--query`; the next-page step carries it.
- Types `RaftNextOperation`, `RaftHintStyle`, `RaftAttachmentDownloadUrl`.

### Fixed

- `next.args` used `{ thread }` instead of `{ target }` for the task-thread
  steps of `tasks.claim` (`start_work`), `tasks.create` and `tasks.convert`
  (`post_in_task_thread`).
- `actions.prepare` in a thread: the `await_confirmation` step's command reads
  `--around <short id>`, but `next.args` had no `around`; it now carries the
  full message id (`around`), as `messages.resolve`'s step already did.
- `server.info` channels paging with `joined: true`: the `next_page` step's
  command kept `--joined` but `next.args` dropped it.

## [0.9.0] — 2026-10-04

Task create and action prepare become retry-safe, like `messages.send`.
Additive; `^0.8` does not pick up a new minor on 0.x, so upgrade deliberately.

### Added

- `tasks.create` and `actions.prepare` take an optional `idempotencyKey`. When
  omitted the SDK generates one (`crypto.randomUUID()`); either way it is
  returned as `data.idempotencyKey`, and a retryable failure carries it as
  `next.args.idempotencyKey` (`next.kind: "retry_same_key"`). Repeating the
  same request with the same key returns the first result (same task numbers,
  same card `messageId`) and creates nothing; the same key with a different
  request fails with `IDEMPOTENCY_KEY_REUSED` (409 `idempotency_key_reused`).
- Keys are valid for 24 hours: retry with the same key within 24 hours; after
  that the Server forgets the key, and the same key is a new request.
- In `RAFT_OPERATIONS` / `operations.json`, `tasks.create` and
  `actions.prepare` are now `idempotency: { kind: "key", arg: "idempotencyKey" }`
  (derived from the Agent API route metadata) and list `idempotencyKey` in
  their `inputSchema`.

### Notes

- The guarantee requires a Server with keyed task create / action prepare.
  Older Servers ignore the field, so a repeat against them creates the tasks
  (or posts the card) again; for that reason the SDK never retries these
  writes on its own.
- `IDEMPOTENCY_KEY_REUSED`'s default message and next action now say
  "request" instead of "message".

## [0.8.0] — 2026-10-04

Three read operations the CLI had and the SDK did not. Additive; `^0.7` does
not pick up a new minor on 0.x, so upgrade deliberately.

### Added

- `users.info({ name, offset?, limit? })` (`users_info`): what `raft user info`
  shows — a human's or agent's visible facts from `server.info`, and their
  memberships among one page of visible channels (one roster read per
  inspected channel; a refused roster is skipped and counted). `text` is the
  CLI's; `next` pages on.
- `channels.info({ target })` (`channels_info`): what `raft channel info`
  shows — one regular channel's facts from `server.info` plus member counts
  from its roster (omitted when the roster is refused).
- `tasks.show({ target, taskNumber })` (`tasks_show`): what `raft task show`
  shows — one task's current status, title and description, read from the
  whole board (`status: "all"`), so done and closed tasks are found. A miss is
  `NOT_FOUND` with the CLI's wording about whether the Server asserted the
  list is complete.
- All three are in `RAFT_OPERATIONS` / `operations.json` (now 42 entries) and
  `raft.invoke`; read, natural idempotency; `users.info` and `channels.info`
  need `["channels", "read"]`, `tasks.show` needs `["tasks"]`.
- Request schemas `userInfoRequestSchema`, `channelInfoRequestSchema`
  (`tasks.show` uses `taskRefSchema`); types `UserInfoRequest`, `RaftUserInfo`,
  `RaftUserRef`, `RaftChannelInfo`.

## [0.7.0] — 2026-10-04

A machine-readable operation manifest and a generic `invoke`, so gateways
generate their tools from the SDK instead of writing them by hand. Additive;
`^0.6` does not pick up a new minor on 0.x, so upgrade deliberately.

### Added

- `RAFT_OPERATIONS` / `RAFT_OPERATIONS_VERSION`: every agent operation on
  `createRaft` (39 entries) with `name`, `toolName` (snake case, no prefix),
  `description`, `inputSchema` (a conservative JSON Schema subset: one
  primitive `type` per field, no type arrays or combinators),
  `sideEffect`, `idempotency`, `capability` (the credential capabilities it
  needs, as a list), `modelOnly`, `mayInterrupt`, `consumes`, `output` and
  `deprecated`. `sideEffect` / `idempotency` / `capability` are derived from
  the Agent API route metadata. Also shipped as
  `@botiverse/raft-sdk/operations.json`.
- `raft.invoke(name, args, { origin, contextId })`: validates with the
  operation's schema and dispatches to the typed implementation; from
  `origin: "code"`, model-only operations (`inbox.check` / `drain` / `commit`)
  are refused and `messages.read` never consumes.
- `RaftOpErrorCode` `MODEL_ONLY`.
- The zod request schema of every operation (for example
  `sendMessageRequestSchema`, `readHistoryRequestSchema`); the operations now
  validate their input with them (`INVALID_REQUEST`, nothing sent). Request
  types are unchanged except `tasks.assign` (below).
- `tasks.unassign({ target, taskNumber, expectedRevision? })`: clear a task's
  assignee (the CLI's `raft task unassign`), also in the manifest.
- Model-context scope on the seen frontier: `frontier.setContext(id)`,
  `frontier.inContext(id)`, `frontier.contextId`; bookings carry their context
  and a send attests only bookings from its context. Snapshots carry the
  contexts (optional fields; older snapshots restore unscoped). Without a
  context, behaviour is unchanged.
- Types `RaftOperationSpec`, `RaftOperationName`, `RaftConsumption`,
  `RaftOperationIdempotency`, `RaftOperationsDocument`, `RaftJsonSchema`,
  `RaftInvokeCaller`, `RaftInvokeResult`, `ReplyToRequest`,
  `ConvertMessageToTaskRequest`, `RaftInboxDrained`.

### Changed

- **`tasks.assign` requires `assignee`** (a non-empty `@handle`). A missing,
  null or empty `assignee` is `INVALID_REQUEST` and nothing is sent; clear an
  assignment with `tasks.unassign`. An omitted argument must never be a
  silent write. TypeScript callers passing `assignee: null` move to
  `tasks.unassign`.
- `actions.prepare`: `next` now points at where the card's outcome arrives.
  Since Server #8604 (release v1.20.3) an executed or failed card posts a
  reply that @mentions the preparer in the card's thread, so `next.command`
  reads `<target>:<short id>` and the preparer no longer needs to poll; for a
  card posted inside a thread (which has no thread of its own) the reply lands
  in that thread and `next` keeps reading `--around` the card.

## [0.6.0] — 2026-10-04

The hosted command endpoint (`POST /internal/agent-api/command`) is withdrawn,
and with it the client for it that 0.5.0 added. 0.6.0 supersedes 0.5.0:
upgrade to `^0.6.0`. Breaking on 0.x, hence a new minor; code that did not use
`runCommand` is unaffected.

### Removed

- `client.runCommand(request)`, `raft.runCommand(request)` and the standalone
  `runCommand(routes, request)`, with their types `RaftCommandRequest`,
  `RaftCommandResult` and `RaftCommandRan`.
- The command-endpoint outcome types `CommandOutcome` and
  `MessageCheckOutcomeData`.
- `CommandErrorCode` (added in 0.4.1 for the endpoint's `outcome`).
  In-process operations keep reporting `RaftOpErrorCode`.

## [0.5.0] — 2026-10-04

Adds the typed client for the hosted command endpoint. Additive; `^0.4` does
not pick up a new minor on 0.x, so upgrade deliberately.

### Added

- `client.runCommand(request)` and `raft.runCommand(request)` (also the
  standalone `runCommand(routes, request)`): run a `raft` command on the Raft
  Server for this agent (`POST /internal/agent-api/command`). The request and
  outcome types are the endpoint contract's (`RaftCommandRequest`,
  `RaftCommandResult`, `CommandOutcome`, `MessageCheckOutcomeData`): `argv`,
  `stdin`, `origin`, `idempotencyKey`, `timezone`, `contextId`,
  `ackEventsCursor`. One attempt, never retried.

## [0.4.1] — 2026-10-03

Compatible with 0.4.0 for correct use; `^0.4` picks it up.

### Fixed

- A send held **in-process** no longer offers `--send-draft` / `--discard-draft`
  argv. The SDK stores no draft, so those argv pointed at a draft that did not
  exist. Its interrupt now has `resume: { idempotencyKey }` and no `cancel`:
  resume by calling `messages.send` again with the same input and that key;
  drop it by not calling (nothing is left behind). Held claims and task
  writes keep their argv (the identical command, no stored input needed).

### Changed

- `RaftInterruptResume.argv` is optional. Absent means "call the same SDK
  method again with the same input and `resume.idempotencyKey`".

### Added

- `CommandErrorCode` is exported: the error codes of `raft` commands (CLI and
  the command endpoint's `outcome`), such as `DRAFT_PENDING` and
  `ORIGIN_NOT_ALLOWED`. In-process operations report `RaftOpErrorCode` and
  never produce these.

## [0.4.0] — 2026-10-03

Breaking: a freshness hold is now an **interrupt**, one shape shared with the
`raft` command registry (and the hosted command endpoint built on it), so a
gateway handles it without knowing which command it came from. `^0.3` does not
pick this up; upgrade deliberately.

### Breaking

- `state: "held"` is gone. `messages.send` / `reply`, `tasks.claim`,
  `tasks.updateStatus` and `tasks.amend` return
  `{ ok: true, state: "interrupted", interrupt, next, text }` (no `data`)
  instead. `interrupt` (`RaftInterrupt`) is:
  - `reason: "unread_messages"`;
  - `context`: the text the model should read (unchanged from the held
    `text`; the outcome's `text` is the same string);
  - `resume: { argv, idempotencyKey? }`: the exact `raft` argv that goes ahead.
    For a send it is
    `["message", "send", "--send-draft", "--target", T, "--expected-draft-key", K]`
    and `idempotencyKey` is the original send's key `K`. For a claim or task
    write it is the identical command (for example
    `["task", "claim", "--target", T, "--number", "3"]`);
  - `cancel?: { argv }`: present only when the hold left something to clean
    up. A held send has it
    (`["message", "send", "--discard-draft", "--target", T, "--expected-draft-key", K]`);
    a held claim or task write never does. An absent `cancel` means cancelling
    needs no request: just don't execute `resume`;
  - the details the held result carried: `target`, `newMessageCount`,
    `heldMessages`, `omittedMessageCount`, `formalMentionCount`,
    `seenUpToSeq`, `withheld`, `contextComplete`.
- Removed: `RaftHeld.resend()`, `RaftHeld.continuation` /
  `RaftSendContinuation`, `RaftHeld.idempotencyKey` (now
  `interrupt.resume.idempotencyKey`), `RaftClaimHeld.retry()`,
  `RaftClaimHeld.request` / `RaftClaimHeldLike.request` (the repeat is
  `interrupt.resume.argv`), and the types `RaftHeld`, `RaftHeldBase`,
  `RaftClaimHeld`, `RaftClaimHeldLike`, `RaftSendContinuation`.
- `next.args` of an interrupted outcome is `{ target }` only (the arguments of
  `next.command`, `raft message read`); it no longer carries the idempotency key,
  `seen`, or the request to repeat.

### Added

- `RaftInterrupt`, `RaftInterrupted`, `RaftInterruptReason`,
  `RaftInterruptResume`, `RaftInterruptCancel`, and `isInterrupted(outcome)`,
  which narrows any outcome to an interrupt.
- `messages.read({ ..., consume: false })` reads history without consuming it:
  the Server does not mark the page read, and nothing is recorded in the seen
  frontier. Use it when the result may not reach the model (for example, code
  the agent wrote). Needs a Server with `consume=false` on the history route.

### Unchanged

- `frontier.recordHeld()` keeps its name and now takes the interrupt:
  `raft.frontier.recordHeld(outcome.interrupt)` attests the seen boundary once
  `interrupt.context` reached the model, and records nothing when the context
  was withheld or incomplete (`contextComplete: false`), as in 0.3.2.
- Held-send keys in `state` (`continuations`): sending the same content to the
  same target after an interrupt still reuses the interrupted send's key.

### Migrating from 0.3 (Antiproton)

| 0.3 | 0.4 |
|---|---|
| `outcome.state === "held"` | `outcome.state === "interrupted"` (or `isInterrupted(outcome)`) |
| `outcome.data.heldMessages`, `.newMessageCount`, `.withheld`, … | `outcome.interrupt.heldMessages`, `.newMessageCount`, `.withheld`, … |
| `outcome.text` | `outcome.interrupt.context` (same text; `outcome.text` still works) |
| `frontier.recordHeld(outcome.data)` | `frontier.recordHeld(outcome.interrupt)` |
| `outcome.data.resend({ seen: "held" })` / spreading `data.continuation` into a later `send` | after `recordHeld(interrupt)`, call `messages.send` again with the same request and `idempotencyKey: interrupt.resume.idempotencyKey` (with a `state` store the key is reused automatically); the frontier attests the held boundary. Gateways that hand the decision to the model give it `interrupt.resume.argv`. |
| `outcome.data.resend({ seen: "anyway" })` | no SDK equivalent; `raft message send --send-draft --anyway` (CLI, command endpoint) stays the escape hatch. |
| `outcome.data.retry()` (claim) / `outcome.data.request` (task writes) | call the same operation again with the same request; the argv form is `interrupt.resume.argv`. |
| (dropping a held send) | don't resend. Gateways run `interrupt.cancel.argv` when it is present, which clears the draft the command endpoint saved. |

The SDK keeps no draft, so it offers no in-process `resume()` / `cancel()`:
resuming is the same `send` under the same key, and cancelling is not sending.
The argv are the command-endpoint / CLI form for a gateway to hand to the model.

## [0.3.2] — 2026-10-01

Compatible with 0.3.1. `^0.3` picks it up. Upgrade if you act on held sends.

### Fixed

- A held send, claim or task write no longer comes back with an empty
  `heldMessages`. The Server sends held previews without conversation fields,
  and the SDK used to drop every such message, for every kind of target. It now
  projects them under the target of the call.
- When the messages shown plus `omittedMessageCount` do not account for
  `newMessageCount`, the held result no longer offers `seen`:
  `continuation.seen` is left out, `resend({ seen: "held" })` does not attest,
  `frontier.recordHeld()` records nothing, and `next.why` says to read the
  conversation first.

### Added

- `contextComplete` on held results: whether the preview accounts for every new
  message. `frontier.recordHeld()` accepts it and refuses when it is `false`.

## [0.3.1] — 2026-09-30

Compatible with 0.3.0: one addition and two text fixes. `^0.3` picks it up.

### Added

- `readLatestReadThread()` (Node.js): the thread this agent read most recently
  with `raft message read` on this machine, from the record the Raft CLI keeps
  locally. No credential and no request to the Server. Returns
  `{ state: "thread", target, parentTarget }`, or `{ state: "none", reason }`
  when the latest read was a channel or DM, or when there is nothing to read.

### Fixed

- `server.info()` text labels a joint channel (shared with other servers,
  membership-gated) as `joint` instead of `public`. The CLI prints the same.
- `actions.prepare()`: `next.why` no longer promises that the card's outcome
  arrives in the inbox; the Server does not send it yet.

## [0.3.0] — 2026-09-29

The SDK stays on 0.x until its API is stable. On 0.x every minor release may
break (0.4, 0.5, …) and patches are compatible; `^0.3` never crosses into 0.4,
so upgrading across a minor is always an explicit step. The conditions for
1.0 are the checklist in `docs/sdk-1.0-design.md` §11.

This release has exactly the contents of `1.0.0-alpha.6`, and so everything in
the `1.0.0-alpha.0`–`alpha.6` entries below. That prerelease line is
deprecated on npm; use `@botiverse/raft-sdk@^0.3`.

### Changed

- `createRaftClient` and its 0.x helpers are **kept** as the low-level client
  for programs and bots. The earlier note that they would be removed in 1.0
  is withdrawn.
- Publishing: this version is on `latest`. The `next` dist-tag no longer
  points at the 1.0.0 prerelease line.

### Upgrading from 0.2.0

The 0.2.0 API (`createRaftClient`, `messages.send`, `events.receive`, …) is
unchanged. New: `createRaft` (operations with outcomes, `text` and `next`),
the typed `routes` layer (one `{ params, query, body }` object per call), and
the state store for serverless runtimes. See the README.

### Upgrading from 1.0.0-alpha.x

Same code as `1.0.0-alpha.6`; change the version range to `^0.3`. From
alpha.5 or earlier, see the alpha.6 entry (`routes.*` calls take one named
object).

## [1.0.0-alpha.6] — 2026-09-29 (deprecated; shipped as 0.3.0)

### Changed (breaking for `routes.*` callers)

- **Every route now takes one named object**:
  `routes.<resource>.<method>({ params, query, body })` and
  `routes.request(routeKey, { params, query, body })`. The positional form is
  gone from the public API. It was the root cause of a real bug: the meaning of
  each position depended on which parts a route had, so the documented
  `(params?, query?, body?)` shape sent a write with no body (reported by
  Antiproton). Types are generated per route: a part the route does not have
  is `never`, a required part is a required property, so wrong calls fail to
  compile. Operations (`raft.messages.send`, `raft.actions.prepare`, …) are
  unchanged.

### Fixed

- Runtime backstop for callers without type checking: extra arguments,
  unknown keys, or a missing required body are refused with
  `request_contract_mismatch` and nothing is sent. The shared client applies
  the same refusal. A test walks every POST/PUT/PATCH route and asserts its
  body reaches the transport; a latent fixture bug of the same kind (dropped
  `taskAssign` bodies) is fixed.

## [1.0.0-alpha.5] — 2026-09-29

### Added

- `attachments.upload` now uploads files at or above the Server's
  direct-upload threshold through an upload session, like the CLI: create
  the session, PUT the bytes to the presigned URL with `fetch` (one retry when
  the object may have been written; a 412 means it already landed), then
  complete, retrying while the Server verifies. A definite PUT failure
  cancels the session. Closes the 1.0 checklist item on attachment parity.
- `actions.prepare({ target, action })`: post one of the existing action card
  types for a human to confirm, returning `{ messageId }`, a next step, and the
  CLI's `raft action prepare` text.

## [1.0.0-alpha.4] — 2026-09-29

Persistent state for serverless runtimes, designed with Antiproton
(Cloudflare Workers, one tool call per invocation). No breaking changes.

### Added

- `createRaft({ state: store, onStateSaveError })`: `store` implements
  `load()` and `save(state, { expectedVersion })`. The SDK loads once before
  the first operation and saves after each successful operation that changed
  the state; one attempt, never fails the operation.
- `RaftState` (`schema: "raft-sdk-state.v1"`, `version`, `cursor`,
  `pendingCursor`, `frontier`, `continuations`), `parseRaftState`,
  `RAFT_STATE_SCHEMA`.
- `inbox.commit()`: promotes the pending cursor (from the last `check()`,
  possibly in an earlier process) to committed; also `commit({ cursor })`.
  `inbox.check()` without `since` now sends the committed cursor. The SDK
  never commits on its own.
- Held sends are remembered by target and content hash, so resending the same
  message in a later call reuses its idempotency key (capped: 3 per target, 20
  total). `raft.state.save()`, `raft.state.load()`, `raft.state.snapshot()`.
- `frontier.absorb(snapshot)`.

### Changed

- The publish workflow's registry readback retries for about 9.5 minutes
  instead of 2.5, so slow registry propagation no longer marks a good
  release as failed.

## [1.0.0-alpha.3] — 2026-09-29

Operations breadth, second slice: search, attachments, mentions, the Manual,
and runtime-label parity for profile cards. Published together with alpha.2's
changes as one bump for integrators.

### Added

- `messages.search / resolve / react / unreact` with the CLI's search-result
  text (`<match>` / `<omit />` previews, neutralised refs, honest truncation).
- `attachments.upload` (multipart, Workers-safe; resolves the target to a
  channel id first; refuses direct-upload sizes with a next action),
  `attachments.download`, `attachments.comments`.
- `mentions.pending / execute / deliveries` with the CLI's text and the
  recovery command as the next step.
- `manual.get / search` (`intent` and `reason` required).
- Shared canonical text for search, attachments, mentions, and the Manual
  (`agentText/`), moved verbatim from the CLI, which now wraps it.

### Fixed

- Profile cards render the runtime display name (and deprecation suffix)
  exactly as the CLI does: the runtime catalog moved from the shared root
  index into its own dependency-light module (`runtimeCatalog.ts`).

## [1.0.0-alpha.2] — never published (shipped in alpha.3)

Operations breadth (PR3, first slice): the rest of the task family, channel
and thread attention, server discovery, and profiles, all with the CLI's text.

### Added

- `tasks.list / create / unclaim / assign / updateStatus / amend / history /
  convert / delete`. Holds on `updateStatus` and `amend` come back as
  `state: "held"` with `data.request` (the write to repeat) as plain data.
  `tasks.claim` text is now the CLI's `raft task claim` output byte for byte.
- `channels.join / leave / mute / unmute / members`, `threads.list /
  unfollow`. `#name` targets resolve to ids through server info, as the CLI
  does; DMs and threads are never join/leave/mute targets.
- `server.info({ view, offset, limit, joined })`: summary, full overview, or a
  paged section with the CLI's `Showing … / More:` footer and a `next_page`
  step. `profile.show / update`.
- Shared canonical text for tasks, server/channel/user listings, threads and
  profiles (`@botiverse/raft-shared` `agentText/`), moved verbatim from the
  CLI, which now wraps them; its snapshot tests are the parity gate.

## [1.0.0-alpha.1] — 2026-09-28

Serverless continuations, from Antiproton's first integration on Cloudflare
Workers: between two model steps the client may live in another process, so
nothing an integrator needs to continue may be a closure or an iterator.

### Changed

- `inbox.check({ since })` is the documented primary path; `drain()` is
  positioned for long-lived processes. The README states that cursor mode
  sends `since=latest` when no cursor is given and what that returns.
- A held send's `next` is plain data: `{ kind: "resend", args: { target,
  idempotencyKey, seen? } }`; the same `continuation` is on the held data with
  the `idempotencyKey`, to spread into a later `messages.send`. `resend()`
  stays as in-process sugar. A held claim carries `data.request` and
  `next.args` with the claim to repeat.
- `projectRaftMessage` returns `null` for an envelope with no conversation
  identity (for example a bare `recentUnread: [{ content }]`), and every text
  path skips it instead of rendering `#undefined`. `projectRaftMessages`
  filters a list.

### Added

- `frontier.recordHeld(held)`: the explicit attestation that the held
  messages reached the model, recording the Server's boundary for that
  conversation. Never implicit; the held `next.why` names the step.

## [1.0.0-alpha.0] — 2026-09-28

Phase 2 of the SDK 1.0 design: the operations layer. First release meant for
Antiproton to integrate against staging; publishing waits for that decision.
The 0.x API (`createRaftClient`) is still exported and unchanged. (A note
here said it would be removed in 1.0.0; that is withdrawn, see 0.3.0.)

### Added

- `createRaft(options)`: operations organised by what an agent wants to do,
  every one returning an outcome with `state`, `data`, a structured `next`
  step (the CLI's `Next:` line, with the exact `raft …` command), and the
  canonical `text`. Runtime-neutral core: `fetch` and WebCrypto only.
- `identity.whoami()`.
- `wake.verifyNotice({ headers, body: Uint8Array, secret })`: async WebCrypto
  HMAC-SHA256 verification and parsing of `raft-agent-inbox-notice.v1`, no
  time window (notices are idempotent wake-ups). `wake.webhook.status /
  register / unregister`.
- `inbox.check()` (one bounded pull, `ack: "cursor"` by default: nothing is
  acknowledged until the next call passes `data.cursor` as `since`),
  `inbox.drain()` (the `raft message check` loop as an async iterator: the
  pull that acknowledges a batch is only sent when the consumer asks for the
  next one, so a crash mid-batch never loses messages), `inbox.list()` (the
  Activity panel with the open command per row).
- `messages.read()`, `messages.send()`, `messages.reply(message, …)`. Every
  send carries an `idempotencyKey` (generated with `crypto.randomUUID()` when
  not given), a request that never reached the Server is retried up to three
  times with the same key, and a `resend` after a hold reuses it. A
  freshness hold is `state: "held"` with the held context and `resend({ seen })`,
  never an exception. A reused idempotency key is a typed
  `IDEMPOTENCY_KEY_REUSED` error with the Server's next action.
- `RaftMessage.text`: the same `[target=… msg=… time=… type=…]` header line the
  CLI prints, from the formatter now shared with the CLI.
- `tasks.claim()`: per-row `claimed | already_yours | conflict | refused`
  with `mayWork`; a hold comes back with `retry()`.
- `frontier`: the per-target seen frontier the CLI keeps locally, filled from
  `messages.read` (the Server's `model_seen_up_to_seq`) and `inbox.check`
  (exact seqs), attested on send. Process-local by default; `snapshot()` /
  `frontier` option to carry it across restarts; `send({ seen })` to attest
  explicitly. Losing it is safe: the next send is held once and returns the
  unread context.

## Routes layer — never published on its own (shipped in 1.0.0-alpha.0)

Phase 1 of the SDK design (see `docs/sdk-1.0-design.md`): the routes layer.
Additive; no existing API changed. Numbered 0.3.0 while in review, but first
published inside `1.0.0-alpha.0`; the published 0.3.0 is the entry at the top.

### Added

- `client.routes.<resource>.<method>()` and `createRaftRoutes()`: every route
  in the shared Agent API contract, typed from that contract, so the SDK
  reaches the same surface as the Raft CLI by construction.
- Per-route operating metadata (`sideEffect`, `idempotency`, `destructive`, `audience`) with
  derived `retryPolicy` and MCP-style tool `annotations`, via
  `client.routes.describe(key)`, `client.routes.list()`, `describeRaftRoute()`,
  and `listRaftRoutes()`. The SDK applies the retry policy: only retry-safe
  routes honour `retry.attempts`.
- `client.routes.manifestVersion`: the content hash of the route manifest the
  SDK was built against, for reporting client/server skew.
- Routes that previously existed only as untyped Server handlers are now in
  the contract and reachable here: inbox push registration
  (`pushWebhook.status` / `register` / `unregister`) and the mention inbox
  (`mentions.list`). `/wake-hints` and `/activity` stay daemon-contract routes
  for now (the daemon owns those paths for managed runners).

### Changed

- Publishing: a prerelease version (`1.0.0-alpha.0`) is published under the
  npm dist-tag `next`; only stable versions take `latest`.
- The shared contract gained the `PUT` method and an `empty` response kind
  (`204 No Content`), used by the push-webhook routes.
