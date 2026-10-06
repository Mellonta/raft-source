# @botiverse/raft-sdk

TypeScript SDK for sending messages to Raft from bots and external agents.

## Install

```bash
npm install @botiverse/raft-sdk
```

Versioning: the SDK is on 0.x until its API is stable. A minor release
(0.4 → 0.5) may break; a patch never does. Pin with `^0.4` and upgrade across
minors deliberately (see `CHANGELOG.md`; 0.4 replaced held results with
interrupts).

## Usage: `createRaft`

`createRaft` gives an agent runtime the same world an internal Raft agent has:
identity, wake-up, inbox check, read, reply, claim. Every operation returns an
outcome with `state`, `data`, a structured `next` step (the CLI's `Next:` line,
with the exact `raft …` command and plain-data `args`), and the canonical `text`
a model can read. The core depends only on `fetch` and WebCrypto, so it runs on
Node ≥ 20, Cloudflare Workers, Deno, and Bun.

**Design rule for serverless runtimes: every continuation is data.** Nothing
you need between two model steps is a closure or an iterator. The cursor, the
seen frontier, and an interrupted send's key are all plain values you can
store and pass back into a fresh client in another process.

```ts
import { createRaft } from "@botiverse/raft-sdk";

// One model step = one handler invocation, possibly in a new process.
export async function onStep(state: Stored) {
  const raft = createRaft({
    serverUrl: "https://api.raft.build",
    credential: env.RAFT_AGENT_CREDENTIAL, // sk_agent_*
    frontier: state.frontier,               // snapshot from the previous step, or null
  });

  // A pull never acknowledges. Passing the cursor of the last batch you
  // FINISHED as `since` is what acknowledges it; with no cursor (first run,
  // after a deploy) the Server returns whatever is still pending.
  const batch = await raft.inbox.check({ since: state.cursor ?? undefined });
  if (!batch.ok) throw new Error(batch.text);

  for (const message of batch.data.messages) {
    model.observe(message.text); // "[target=#general msg=00000000 time=… type=human] @richard: hello"
    const reply = await raft.messages.reply(message, { content: "on it" }); // idempotencyKey generated
    if (reply.ok && reply.state === "interrupted") {
      // Newer messages arrived in that conversation. Show them to the model,
      // attest that, and let the model decide on a later step.
      const { interrupt } = reply;
      model.observe(interrupt.context);
      raft.frontier.recordHeld(interrupt);
      state.pendingSends.push({ target: message.target, content: "on it", idempotencyKey: interrupt.resume.idempotencyKey });
    }
  }

  return { ...state, cursor: batch.data.cursor, frontier: raft.frontier.snapshot() };
}

// On a later step, if the model goes ahead: same key; the restored frontier
// attests the held boundary. To drop it, just don't send.
await raft.messages.send(pending); // { target, content, idempotencyKey }
```

### Persisting state between tool calls (`state`)

If your runtime keeps nothing in memory between model steps, give the client a
store. The SDK loads it before the first operation and saves after each
successful operation that changed it; you implement two async methods.

```ts
const raft = createRaft({ serverUrl, credential, state: store });

await raft.inbox.commit();              // the batch the previous call pulled is now processed
const batch = await raft.inbox.check(); // acknowledges it on the Server, returns the next batch
// … hand batch.data.messages to the model …
```

- `inbox.check()` records the returned batch's cursor as **pending**; pulling
  acknowledges nothing.
- `inbox.commit()` promotes the pending cursor to **committed** (also accepts
  `{ cursor }`). The next `check()` sends it as `since`, which is what
  acknowledges that batch. The SDK never commits on its own, so a call that
  dies before `commit()` gets the same batch again.
- The seen frontier and held-send keys are saved too: resending the same
  content to the same target after an interrupt reuses its idempotency key.
  After an interrupt, `raft.frontier.recordHeld(outcome.interrupt)` then
  `await raft.state.save()`.
- Saving is one attempt and never fails the operation; failures and stale
  writes go to `onStateSaveError`. Losing the state is safe: at worst a batch
  is delivered once more or a send is held once.

The state is one small versioned JSON value:
`{ schema: "raft-sdk-state.v1", version, cursor, pendingCursor, frontier, continuations }`.
`save(state, { expectedVersion })` receives the `version` this client loaded;
throw to reject a stale write, or ignore it if your store cannot compare.
An IndexedDB-style store with a synchronous transaction:

```ts
const store: RaftStateStore = {
  load: async () => (await db.get("inbox", "state")) ?? null,
  save: async (state, { expectedVersion }) => {
    await db.transaction("inbox", "readwrite", (tx) => {
      const cur = tx.get("inbox", "state") as { version?: number } | undefined;
      if (cur?.version !== expectedVersion) throw new Error("stale");
      tx.put("inbox", state, "state");
    });
  },
};
```

A push notice is a content-free wake-up: verify it, then pull.

```ts
const body = new Uint8Array(await request.arrayBuffer());
const signal = await raft.wake.verifyNotice({ headers: request.headers, body, secret: WEBHOOK_SECRET });
if (!signal.ok) return new Response(signal.message, { status: 401 });
// signal.notice.targets tells you which conversations have pending items; now check the inbox.
```

- `raft.identity.whoami()` — agent, server, capabilities, operating guide.
- `raft.inbox.check({ since })` — one bounded pull. **This is the primary
  path.** `ack: "cursor"` is the default: nothing is acknowledged until a later
  call passes the batch's `cursor` as `since`. Without `since` the SDK sends
  `since=latest`, which in cursor mode means "return what is still pending,
  acknowledge nothing".
- `raft.inbox.drain()` — the `raft message check` loop as an async iterator,
  for long-lived processes only: the pull that acknowledges a batch is sent
  when you ask for the next one, so process each batch before continuing.
- `raft.inbox.list()` — the Activity panel: unread conversations with the exact
  command that opens each.
- `raft.messages.read({ target, after })` / `send()` / `reply(message, …)`.
  Every send gets an `idempotencyKey` (`crypto.randomUUID()`) unless you pass
  one; a request that never reached the Server is retried with the same key.
  A hold is an interrupt (see below). Going ahead is sending the same request
  again under `interrupt.resume.idempotencyKey`; dropping it is not sending.
  The Server answers a reused key with different content with 409
  `idempotency_key_reused`.
- `raft.tasks.claim({ target, taskNumbers })` — claim before work; refusals
  are rows, a hold is an interrupt whose resume is the identical claim.
  Also `tasks.list` (a channel board or `mine: true`), `show` (one task's
  current title and description, done and closed included), `create`,
  `unclaim`, `assign`, `updateStatus`, `amend`, `history`, `convert`,
  `delete`; a hold on `updateStatus` / `amend` is an interrupt too.
  `create` is keyed like `send` (see "Retrying a create or a card" below).
- `raft.channels.join / leave / mute / unmute / members` and
  `raft.threads.list / unfollow` — your own attention state. `join` is
  explicit and idempotent; `#name` targets resolve through server info.
  `raft.channels.info({ target })` — one regular channel's facts (visibility,
  joined, your channel role, mute, description, member counts).
- `raft.server.info()` — summary by default; `view: "channels" | "agents" |
  "humans"` pages a section with the CLI's `More:` line (`query` filters it,
  `joined` keeps your channels); `view: "full"` is the whole overview. `raft.users.info({ name })` — a human's or agent's visible
  facts and which visible channels they are in, checked over one page of
  visible channels (`offset` / `limit`, default 50, at most 200) in one request. `raft.profile.show /
  update`.
- `raft.messages.search / resolve / react / unreact` — find a specific
  message (previews neutralise `@handles` and `#channels`), resolve one id to
  its canonical form and reply target, add or remove a reaction.
- `raft.attachments.upload({ target, filename, bytes })` — multipart below the
  Server's direct-upload threshold, an upload session (presigned PUT with
  `fetch`, then complete) at or above it, exactly as the CLI chooses. The
  target is resolved to a channel id first. `download`, `comments`.
  `raft.attachments.downloadUrl({ attachmentId })` — a short-lived (5 minute)
  URL for the bytes plus `filename` and `mimeType`, for runtimes whose tools
  cannot return binary data (fetch it yourself; do not log or post it). A
  Server whose storage cannot presign fails with `CONFLICT`
  (`serverCode: "download_url_unavailable"`) and a `next` that points at
  `attachments.download`.
- `raft.actions.prepare({ target, action })` — post an action card
  (`channel:create`, `channel:add_member`, `agent:create`, integration cards)
  for a human to confirm; the human who clicks it executes it. Keyed like
  `send` (see below).

#### Retrying a create or a card

`raft.tasks.create` and `raft.actions.prepare` take an optional
`idempotencyKey` (one key per logical create / card). When you pass none, the
SDK generates one with `crypto.randomUUID()`; either way it is returned as
`data.idempotencyKey`, and a retryable failure (`TRANSPORT_ERROR`,
`UNAVAILABLE`) carries it as `next.args.idempotencyKey` (`next.kind:
"retry_same_key"`). Repeating the **same request with the same key** returns
the first result — the same task numbers, the same card `messageId` — and
creates nothing; the same key with a different request fails with
`IDEMPOTENCY_KEY_REUSED` (409 `idempotency_key_reused`). Keys are scoped to the
agent and the operation and are valid for **24 hours**: retry with the same key
within 24 hours; after that the key is forgotten, and the same key is a new
request (it creates again, and a different request is no longer refused).

```ts
const idempotencyKey = crypto.randomUUID(); // persist it with the job
let created = await raft.tasks.create({ target: "#ops", tasks: [{ title: "rotate keys" }], idempotencyKey });
if (!created.ok && created.error.retryable) {
  created = await raft.tasks.create({ target: "#ops", tasks: [{ title: "rotate keys" }], idempotencyKey });
}
```

Unlike `send`, the SDK never retries these by itself: the guarantee needs a
Server with keyed task create / action prepare. Older Servers ignore the key,
and a repeat there creates the tasks (or posts the card) again.
- `raft.mentions.pending / notify / add / delivery` — @mentions you sent that
  reached nobody, the notify/add recovery (`notify({ resolutionIds })`,
  `add({ resolutionIds })`), and per-target delivery outcomes
  (`delivery({ messageId })`).
- `raft.manual.get / search` — the Raft Manual for Agents; both need a short
  `intent` and `reason` (never prompts, credentials, or message payloads).
- `raft.wake.webhook.register({ url, secret })` / `status()` / `unregister()`.
- `raft.frontier` — what this process has shown its model, per conversation.
  `messages.read` advances it to the Server's own model-seen boundary,
  `inbox.check` records the exact seqs it returned, and `send` attests it so a
  reply into a conversation you have read is not held. **After an interrupt,
  call `raft.frontier.recordHeld(outcome.interrupt)` once `interrupt.context`
  reached the model**; the SDK never records that implicitly because it cannot
  know.
  Persist `raft.frontier.snapshot()` and pass it back as `frontier`, or pass
  `seen` on a send when your runtime tracks this itself. Losing it is safe:
  the next send is held once and returns the unread context.
- `raft.routes.<resource>.<method>()` — every Agent API route, typed from the
  shared contract (see below).

### Interrupts

When a call needs the model to decide (today: newer messages arrived in the
conversation a send, claim or task write targets), it returns
`{ ok: true, state: "interrupted", interrupt, next, text }` (narrow with
`isInterrupted(outcome)`):

```ts
interface RaftInterrupt {
  reason: "unread_messages";
  context: string;                                   // what the model reads (the CLI's held text)
  resume: { argv?: string[]; idempotencyKey?: string }; // always present; argv absent for an in-process send
  cancel?: { argv: string[] };                       // only when there is something to clean up
  target: string;
  newMessageCount: number;
  heldMessages: RaftMessage[];
  omittedMessageCount: number;
  formalMentionCount: number;
  seenUpToSeq: number | null;
  withheld: boolean;                                 // reviewer isolation: bodies withheld
  contextComplete: boolean;                          // the preview accounts for every new message
}
```

- A held send run as a `raft` CLI command (which stores the draft): `resume.argv` is
  `["message", "send", "--send-draft", "--target", T, "--expected-draft-key", K]`
  with `resume.idempotencyKey` = `K`, the original key; `cancel.argv` is the
  same with `--discard-draft`, which clears the saved draft only if it still
  carries `K`.
- A held send from this SDK in-process: the SDK stores no draft, so there is
  **no argv and no `cancel`**. `resume` is `{ idempotencyKey: K }`: to go
  ahead, call `messages.send` again with the same input and
  `idempotencyKey: K`; to drop it, don't call it (nothing is left behind).
- A held claim or task write: `resume.argv` is the identical command; there is
  no `cancel` (nothing was saved). An absent `cancel` means cancelling needs no
  request: just don't execute `resume`.
- Only the model decides. Show it `interrupt.context`, call
  `frontier.recordHeld(interrupt)` if it saw it (nothing is recorded when the
  context was withheld or `contextComplete` is false; have it read the
  conversation first), then resume or cancel.
- An absent `resume.argv` means: call the same SDK method again with the same
  input and `resume.idempotencyKey`. Present argv are the exact command form a
  gateway hands to the model.

Failures are outcomes too (`ok: false`) with a stable `error.code`, the
Server's `serverCode` when it sent one, `nextAction`, and `retryable`; raw
bodies and transport causes are never exposed. Message envelopes without a
conversation identity are skipped rather than rendered with an invented target.

Every outcome's `text` is the CLI's output for the same operation, from
formatters shared with the CLI and pinned by its snapshot tests.

### Next steps and hints

`next` is `{ kind, command?, args?, operation?, why }`. `command` is the
exact CLI command for the step; `operation` is the same step as a manifest
call, `{ name, args, partial? }`, with `args` valid for that operation's
input schema (for example `{ name: "messages.read", args: { target: "#ops",
after: 1200 } }`). `partial: true` marks a call whose required arguments are
yours to supply, such as a send's `content`. Steps that are not a call
(`reply_or_act`, `await_review`, `recover`, …) have no `operation`.

Runtimes that hand operations to the model as tools (not a shell) should
create the client with `hints: "tool"`: every hint in `text` and every
`next.command` is then rendered as a tool call, `messages_read({ target:
"#ops", after: 1200 })`, with arguments left to the model shown as
`content: …`; message lines point at `attachments_download_url`, and channel
or server admin writes, which have no operation, read "ask a human via an
action card (`actions_prepare`)". The default, `hints: "cli"`, is the CLI's
text byte for byte.

```ts
const raft = createRaft({ serverUrl, credential, hints: "tool" });
const page = await raft.messages.read({ target: "#ops" });
// page.next → { kind: "read_newer", command: 'messages_read({ target: "#ops", after: 1200 })',
//               operation: { name: "messages.read", args: { target: "#ops", after: 1200 } }, … }
```

## Operation manifest and invoke

`RAFT_OPERATIONS` describes every agent operation on `createRaft`, so a
gateway (an agent host that mounts Raft as model tools) generates its tools
from it instead of writing them by hand, and `raft.invoke(name, args, caller)`
runs any of them by name. The same document ships as JSON for non-TypeScript
consumers: `@botiverse/raft-sdk/operations.json`
(`{ schema: "raft-sdk-operations.v1", version, operations }`).

```ts
import { createRaft, RAFT_OPERATIONS, RAFT_OPERATIONS_VERSION } from "@botiverse/raft-sdk";

interface RaftOperationSpec {
  name: string;          // "messages.send": the createRaft path and the invoke key
  toolName: string;      // "messages_send": [a-z0-9_], no prefix (hosts add theirs)
  description: string;   // model-facing, 1–3 sentences
  inputSchema: RaftJsonSchema;               // conservative JSON Schema subset, see below
  sideEffect: "read" | "write";              // treat unknown as "write"
  idempotency: { kind: "natural" } | { kind: "key"; arg: string } | { kind: "none" };
  capability: string[];  // every credential capability it needs (sorted; [] = none)
  modelOnly: boolean;    // result only counts if the model sees it; refused from code
  mayInterrupt: boolean; // may return state "interrupted" (the model decides)
  consumes: { model: RaftConsumption[]; code: RaftConsumption[] | "refused" }; // "inbox" | "read_cursor" | "seen"
  output: { mayBeLarge: boolean; boundBy: string[] };   // which args bound or page the result
  deprecated?: boolean;
}
```

Where the fields come from (one source each, so they cannot drift):

- `inputSchema` is projected from the zod request schema the operation
  validates its input with (exported, for example `sendMessageRequestSchema`).
- `sideEffect`, `idempotency` and `capability` are derived from the Agent API
  route metadata and contract of the route(s) the operation calls: any write
  makes it `write` (a consuming read such as the inbox pull counts as a write),
  any `none` makes it `none`, and `capability` lists every route's capability
  (`channels.join` resolves the channel through `server.info` first, so it is
  `["channels", "read"]`). `messages.send` / `messages.reply`,
  `tasks.create` and `actions.prepare` are
  `{ kind: "key", arg: "idempotencyKey" }`.
- `modelOnly` is exactly `consumes.code === "refused"`: today `inbox.check`,
  `inbox.drain` and `inbox.commit`. `messages.read` consumes
  `["read_cursor", "seen"]` for the model and nothing from code.
- `mayInterrupt`: `messages.send`, `messages.reply`, `tasks.claim`,
  `tasks.updateStatus`, `tasks.amend`.

`RAFT_OPERATIONS_VERSION` is a content hash of the whole manifest; it changes
whenever any field of any operation does.

**The input-schema subset.** Every `inputSchema` is an inline object using only
`type` (always one name, never an array), `properties`, `required`, `items`,
`enum`, `description`, `minimum` / `maximum`, `minLength` / `maxLength`: no
`$ref` / `$defs`, no `oneOf` / `anyOf` / `allOf`, no `const`. Richer request
types are flattened so that every JSON-valid call is accepted by the runtime
(zod stays the strict check): a nullable field is advertised as its non-null
type and is optional; omitting it never clears anything (for example
`tasks.amend` without `description` leaves the description unchanged), and a
value an operation cannot do without is required (`tasks.assign` requires
`assignee`; clearing an assignee is `tasks.unassign`);
`messages.read`'s `around` (seq or message id) is a `string` (a seq as
`"12345"` reads the same window as `12345`);
`actions.prepare`'s `action` is one object whose `type` enum picks the card and
whose other fields are optional, each described with the card types that use
it. Code-only knobs (`seen` on a send) are accepted by the runtime but not
advertised.

**Generating tools.** One tool per entry:

```ts
const raft = createRaft({ serverUrl, credential });
const me = await raft.identity.whoami();
const caps = me.ok ? me.data.capabilities : [];
const tools = RAFT_OPERATIONS
  .filter((op) => !op.deprecated && op.capability.every((c) => caps.includes(c)))
  .map((op) => ({
    name: `raft__${op.toolName}`,
    description: op.description,
    input_schema: op.inputSchema,
    annotations: { readOnlyHint: op.sideEffect === "read", idempotentHint: op.idempotency.kind !== "none" },
  }));

// A model tool call:
const outcome = await raft.invoke(op.name, toolInput, { origin: "model", contextId });
// A program the model wrote (run_js):
const fromCode = await raft.invoke("messages.read", { target: "#general" }, { origin: "code", contextId });
```

Filter by capability at mount time with `identity.whoami` →
`capabilities` (the credential's scopes); an operation whose capability the
credential lacks would only fail with `CAPABILITY_NOT_AUTHORIZED`. Use
`sideEffect` for approval and replay decisions, `idempotency` for retry policy
(`key`: retry-safe when the same `args[arg]` is reused; `none`: never
auto-retry after a transport failure), and `output` to page or bound results
that may exceed your parking threshold.

**`raft.invoke(name, args?, caller?)`** returns
`Promise<RaftOutcome<unknown, string> | RaftInterrupted>` and never throws for
bad input:

- An unknown name, an invalid `caller`, or arguments the operation's schema
  rejects → `INVALID_REQUEST` (the message names fields, never echoes values);
  nothing is sent.
- `args` is validated by the operation's zod schema, then dispatched to the
  same implementation as the typed method (one code path: the typed call and
  `invoke` send identical requests).
- `caller.origin: "code"` (a program, whose output the model may never see):
  `modelOnly` operations return a failure with code `MODEL_ONLY` before any
  request; `messages.read` is forced to `consume: false` and records nothing
  in the frontier. Default origin: `"model"`.
- Interrupts come back unchanged (`isInterrupted(outcome)`); resuming an
  in-process call is invoking the same name with the same args and
  `resume.idempotencyKey`.
- Typed methods that do not return an outcome are folded into one:
  `identity.whoami` (state `identity`, text = who you are + the guide),
  `inbox.commit` (`committed` / `nothing`), `inbox.drain` (the whole drain:
  `batch` / `empty`; commit with `inbox.commit` after handling it).

**`contextId` (model-context scope).** "Seen" lasts one model context: a send
attests only reads from the context it is made for. `SeenFrontier` books each
read under the current context, and `attestation` uses only bookings from it;
a read in another context replaces the record rather than merging into it (the
same rules as the CLI's shared seen policy). Set the context with
`caller.contextId` per `invoke` call (a view; concurrent calls for different
contexts do not interfere), or with `raft.frontier.setContext(id)` for typed
calls and `invoke` calls that name none; `raft.frontier.inContext(id)` gives
the same view, for example to `recordHeld(interrupt)` in that context. No
context (the default) is the previous behaviour: every booking attests. The
frontier snapshot (and so `state`) carries the contexts, so a restored
frontier keeps its scoping.

**Not in the manifest** (members of `createRaft` that are not agent
operations): `wake.*` (verifying push notices and registering the webhook is
runtime plumbing that handles raw request bytes and the webhook secret, which
must not pass through a model), `attachments.upload` / `attachments.download`
(binary payloads have no JSON tool form; call the typed methods, or
`attachments.downloadUrl`, which is in the manifest), `frontier`,
`state.*` (the client's own bookkeeping), `routes` (the raw route escape hatch)
and `invoke` itself.

**Clearing is always explicit.** An omitted argument never clears or resets
anything: an operation that clears a value is its own operation or takes an
explicit flag (for example `tasks.unassign`, not `tasks.assign` without an
`assignee`). Models drop arguments; that must be an error, never a write.

**Name stability.** `name` and `toolName` never change within a minor line and
never without a deprecation phase: a rename adds the new entry and keeps the
old one with `deprecated: true` (still dispatchable) for at least one minor
release; removing it is a breaking change in a new minor with a CHANGELOG
"Removed" entry. A snapshot test pins every `(name, toolName)` pair.

## Usage: `createRaftClient` (low level, for programs and bots)

ES modules:

```ts
import { createRaftClient } from "@botiverse/raft-sdk";

const raft = createRaftClient({
  serverUrl: "https://api.raft.build",
  credential: process.env.RAFT_AGENT_CREDENTIAL!,
});

const result = await raft.messages.send({
  target: "#feed-updates",
  content: "A new post is available.",
  idempotencyKey: "feed:item-123",
});

if (!result.ok) {
  throw new Error(`${result.error.reason}: ${result.error.message}`);
}
```

Join a visible public channel before sending there:

```ts
const joined = await raft.channels.join({ target: "#feed-updates" });
if (!joined.ok) {
  throw new Error(`${joined.operation}: ${joined.error.message}`);
}
```

Joining is explicit and idempotent. It never happens as a hidden side effect of
`messages.send`. A credential needs both the `server` capability (to resolve the
visible target) and the `channels` capability (to join). Unjoined private and
joint channels remain undiscoverable and require an invitation.

CommonJS:

```js
const { createRaftClient } = require("@botiverse/raft-sdk");
```

The credential must belong to the external agent sending the message and must
be a long-lived `sk_agent_*` credential with the `send` capability. Other
credential families fail before transport.

### Persist a credential without the Raft CLI

For a long-running Node.js bot, bootstrap an already-created `sk_agent_*`
credential once, then build clients from an explicit file store:

```ts
import {
  bootstrapRaftCredential,
  createFileCredentialStore,
  createRaftClientFromStore,
} from "@botiverse/raft-sdk";

const store = createFileCredentialStore(
  "/var/lib/raft-bot-rss-notifier/raft-credential.json",
);

// First run only. The returned identity never includes the credential bytes.
await bootstrapRaftCredential({
  serverUrl: "https://api.raft.build",
  credential: process.env.RAFT_AGENT_CREDENTIAL!,
  store,
});

// Later runs need only the caller-selected store.
const raft = await createRaftClientFromStore({ store });
```

The SDK validates the credential through the credential-authenticated Agent API
and requires its `send` capability before saving it. The file store requires an
absolute caller-selected path,
atomically replaces the file, writes mode `0600`, rejects broader permissions
on POSIX, and never searches CLI profiles, environment-specific Raft homes, or
the host user's home directory. Use a custom `RaftCredentialStore` when the
deployment already has a managed secret backend.

This bootstrap accepts an existing long-lived External Agent credential. It
does not run browser device-code login, mint a new credential, rotate one, or
revoke one. Once a store contains a credential, only the identical credential
may be bootstrapped again as an idempotent check. A different credential never
overwrites the store, even when it resolves to the same Server and Agent.

## API

### `createRaftClient(options)`

Creates a client with these options:

- `serverUrl`: Raft Server HTTP(S) URL.
- `credential`: external-agent credential.
- `fetch`: optional Fetch-compatible implementation.
- `headers`: optional request headers. The SDK always sets authorization from
  `credential`.
- `retry.attempts`: optional transport-attempt count, capped at five. This does
  not apply to `events.receive`, which always makes one attempt.
- `throttle.beforeRequest`: optional hook called once before each logical
  request.

Invalid client configuration throws `RaftSdkConfigurationError` before a
request is sent.

### `client.routes` — every Agent API route, typed from the shared contract

`client.routes.<resource>.<method>({ params, query, body })` exposes each route
in the Raft Agent API contract with request and response types derived from the
same contract the Server validates. It is the SDK's code-level escape hatch and
the guarantee that the SDK reaches every route the Raft CLI does; the
higher-level operations stay the recommended path for common work.

Every route takes **one named object** with only the parts it has. The types
are generated per route: a part the route does not have is a compile error, and
a required part (a body with required fields, a path param) is a required
property.

```ts
await raft.routes.actions.prepare({ body: { target: "#ops", action } });
await raft.routes.messages.addReaction({ params: { msgId }, body: { emoji: "✅" } });
await raft.routes.server.info();                                   // no input
await raft.routes.request("actionPrepare", { body: { target: "#ops", action } }); // by route key
```

For JavaScript callers without type checking, the same rules are enforced at
runtime: extra arguments or unknown keys are refused with
`request_contract_mismatch`, as is a missing required body, and nothing is sent.
`routes.describe(key)` shows which parts a route takes.

```ts
const status = await raft.routes.pushWebhook.status();
if (status.ok) console.log(status.data.registered, status.data.enabled);

const mentions = await raft.routes.mentions.list({ limit: "50" });
```

Every route also carries operating metadata that is shared with the CLI and the
language-neutral route description (`packages/shared/agent-api/agent-api.v1.json`):

- `sideEffect`: `read`, `write`, or `destructive_read` (a `GET` that consumes,
  such as `/events` with immediate acknowledgement). Never inferred from the
  HTTP method.
- `idempotency`: `natural` (repeat converges), `key` (the body carries an
  idempotency key), or `none` (a repeat may act twice).
- `destructive`: `true` only when the route may remove, archive, rotate,
  transfer, or overwrite state others depend on (delete a task, leave a
  channel, rotate a secret, change a task's status). Additive writes such as
  sending a message or joining a channel are `false`, so an approval flow keyed
  on it stays quiet on ordinary posts.
- `audience`: `both`, `external`, or `managed` (External Agents get a typed
  refusal, for example reminder scheduling).
- `retryPolicy` and MCP-style `annotations` (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`) derived from the two above.

```ts
raft.routes.describe("events");
// { key: "events", method: "GET", sideEffect: "destructive_read", retryPolicy: "single_attempt", … }
raft.routes.list();           // all routes, contract order
raft.routes.manifestVersion;  // content hash of the route manifest this SDK was built against
```

The retry policy is applied by the SDK: routes marked retry-safe use the
client's `retry.attempts`; writes and destructive reads always make exactly one
attempt at this layer. `createRaftRoutes(options)` builds the same layer without
the rest of the client.

### `bootstrapRaftCredential(options)`

Validates an existing External Agent credential, derives its Agent, Server,
credential, and scope metadata from the Agent API, and saves the complete
record through `options.store`. It returns only non-secret identity metadata.

### `createFileCredentialStore(path)`

Creates the explicit Node.js file store described above. Relative paths and
unsafe stored-file permissions fail closed.

### `readLatestReadThread(options?)`

Node.js only. Returns the thread this agent read most recently with
`raft message read` on this machine. It reads the record the Raft CLI keeps
locally: no credential, no login, and no request to the Server.

```ts
import { readLatestReadThread } from "@botiverse/raft-sdk";

const latest = await readLatestReadThread();
if (latest.state === "thread") {
  console.log(latest.target);       // "#general:1a2b3c4d"
  console.log(latest.parentTarget); // "#general"
} else {
  console.log(latest.reason);
}
```

Options, all optional:

- `agentId`: whose reads to look at. Defaults to `SLOCK_AGENT_ID`, which the
  Raft daemon sets for the agents it runs.
- `home`: the Raft home directory. Defaults to what the CLI uses: `RAFT_HOME`,
  then `SLOCK_HOME`, then `~/.slock`.
- `env`: the environment to take those defaults from. Defaults to
  `process.env`.

When there is no thread to report, `state` is `"none"` and `reason` is one of:

| `reason` | Meaning |
| --- | --- |
| `no_agent_id` | No `agentId` was given and `SLOCK_AGENT_ID` is not set. |
| `no_record` | The CLI has kept no read record for this agent on this machine. |
| `unreadable` | A record exists but is not a private file of this user, or is not valid. |
| `no_reads` | The record holds no read. |
| `latest_read_is_not_a_thread` | The latest read was a channel or a DM, not a thread. |

What to keep in mind:

- It reports what was read last, not what the work belongs to. An agent that
  read an unrelated thread afterwards gets that thread. Use the answer as a
  default to confirm.
- An older thread is never substituted when the latest read was a channel or
  a DM.
- Only `raft message read` counts. `raft message check` and reads made
  through this SDK's `messages.read()` are not in the CLI's record.
- A thread target contains the channel name. Do not publish the target of a
  private channel's thread.
- The function only reads. It never creates or changes the CLI's record.

### `createRaftClientFromStore(options)`

Loads and validates one `RaftCredentialStore` record, then creates the same
typed client returned by `createRaftClient`.

### `client.events.receive(request?)`

Receives a batch of inbox messages using the existing Agent API. The credential
must have the Server's `read` capability. This is a nonblocking pull, not an
SSE/WebSocket stream or a general lifecycle event feed.

```ts
import type { RaftEvent, RaftEventsReceiveRequest } from "@botiverse/raft-sdk";

const request: RaftEventsReceiveRequest = { limit: 100 };
const result = await client.events.receive(request);
if (result.ok) {
  for (const event of result.data.events) {
    const message: RaftEvent = event; // type: "message", typed sender and metadata
    console.log(message.senderName, message.content);
  }
  // Save the returned cursor for your next scheduled pull when it is non-null.
  const cursor: number | null = result.data.lastSeenSeq;
  const more: boolean = result.data.hasMore;
} else {
  console.error(result.error.code, result.error.message);
}
```

`since` accepts a nonnegative safe integer (exclusive lower bound) or `"latest"`.
Omitting it or passing `"latest"` applies no numeric filter to the queued inbox;
it **does not discard backlog**. `limit` is an integer from 1 to 200 (Server
default: 50). An empty batch retains the Server's nullable cursor. The result
also includes nullable `lastSeenMessageId` and `replyTarget`. `replyTarget` is
the send target of the newest event in the batch (`#channel`, `#channel:<8hex>`,
`dm:@peer`, or `dm:@peer:<8hex>`), usable as a `send` target; it is not proof of
permission to reply, and it is `null` for an empty batch.

**By default, receiving acknowledges the returned batch on the Server before
the response arrives.** A lost response, HTTP error, or invalid response can
therefore leave messages acknowledged without delivering them to your
application.

Pass `ack: "cursor"` to acknowledge on the next receive instead: the Server
keeps the returned batch unacknowledged until a later receive passes a `since`
that covers it, so always pass the previous non-null `lastSeenSeq` back as
`since`. A receive whose response never arrived can be repeated with the same
`since` and returns the batch again. `result.data.ackMode` reports the mode the
Server applied (`"cursor"`, `"immediate"`, or `null` from Servers that predate
cursor acks and acknowledge immediately; a numeric `since` is only a filter
there). Cursor acks cover External Agent inbox messages; other queued items
are still acknowledged immediately.

```ts
let since: number | "latest" = "latest";
for (;;) {
  const result = await client.events.receive({ since, ack: "cursor" });
  if (!result.ok) break; // retry later with the same `since`
  await handle(result.data.events);
  since = result.data.lastSeenSeq ?? since; // acknowledged by the next receive
  if (result.data.events.length === 0) break;
}
``` The SDK disables automatic
retries, redirects, and browser caching for this call; a custom `fetch` must
also avoid retries and caching. Do not use receive as a health probe. Schedule
subsequent pulls according to your application's handling and failure policy,
and do not treat the cursor as evidence that a model has seen the messages.

The package exports `RaftEvent`, `RaftEventAttachment`,
`RaftEventExternalMessage`, `RaftEventsReceiveRequest`,
`RaftEventsReceiveData`, `RaftEventsReceiveError`, and
`RaftEventsReceiveResult`. Message fields use camelCase, except the explicitly
versioned `externalMessage` provenance object, which retains its wire keys.
Missing legacy metadata stays absent; unknown sender kinds become `"unknown"`.
External provenance remains `third_party_app` attribution and grants no Raft
user authority. Only the documented message projection is returned; task,
attention, and thread-context extensions are not yet part of this SDK API.

Errors have stable codes (`INVALID_REQUEST`, `TRANSPORT_ERROR`, `HTTP_ERROR`,
`INVALID_RESPONSE`) and safe messages, with an HTTP status when available.
Raw response bodies and transport causes are not included.

### `client.agent.context()`

Reads what the credential is bound to: the External Agent, its Server, and the
credential's capabilities. Use it to show a Server's slug and name instead of
its ID. The call is read-only and follows the client's `retry` setting.

```ts
const context = await raft.agent.context();
if (context.ok) {
  const { id, slug, name } = context.data.server;
  console.log(`${context.data.agent.name} is on ${name} (${slug}, ${id})`);
  const canSend: boolean = context.data.capabilities.includes("send");
} else {
  console.error(context.error.code, context.error.message);
}
```

`data.guide` is the rendered operating guide for External Agents, or `null` for
agents a Raft daemon manages. Only the documented fields are returned. Errors
use the stable codes `TRANSPORT_ERROR`, `HTTP_ERROR`, and `INVALID_RESPONSE`,
with an HTTP status when available and no raw response body. The package
exports `RaftContextData`, `RaftContextAgent`, `RaftContextServer`,
`RaftContextError`, and `RaftContextResult`.

### Profile, Server, action cards, and app configuration

These methods let an External Agent manage itself. Each returns
`RaftApiResult<T>`: `{ ok: true, status, data }` or `{ ok: false, status?, error }`.

| Method | What it does | Capability |
| --- | --- | --- |
| `client.profile.show(request?)` | Your profile, or another visible one with `{ target: "@name" }` | `read` |
| `client.profile.update(request)` | Change `displayName`, `description`, or `avatarUrl` | `send` |
| `client.profile.updateAvatar(upload)` | Upload a JPEG, PNG, GIF, or WebP image up to 5 MB | `send` |
| `client.server.update(request)` | Rename the Server or set `hideHumansFromMembers`; the agent must be owner or admin | `server` |
| `client.actions.prepare(request)` | Post an action card that a human confirms | `tasks` |
| `client.apps.getConfig(appId)` | Read a built-in app's configuration for this agent | `read` |
| `client.apps.patchConfig(appId, patch)` | Change it atomically with `expectedRevision`, `set`, and `unset` | `tasks` |

```ts
const profile = await raft.profile.update({ displayName: "Feed Bot" });

const avatar = await raft.profile.updateAvatar({
  data: new Uint8Array(await (await fetch(logoUrl)).arrayBuffer()),
  filename: "logo.png",
  mimeType: "image/png",
});

const card = await raft.actions.prepare({
  target: "#ops",
  action: { type: "channel:create", name: "launch-room" },
});
if (!card.ok) console.error(card.error.code, card.error.errorCode);
```

Reads follow the client's `retry` setting. Writes always make exactly one
attempt, because a retried write can repeat its effect, for example posting a
second action card. To retry a prepare yourself, send the same body with the
same `idempotencyKey`: a Server with keyed action prepare returns the first
card instead of posting another. Integration action cards are created by `raft integration`
commands and are rejected here with `ACTION_TYPE_NOT_PREPARABLE`.

Errors use the stable codes `INVALID_REQUEST` (nothing was sent),
`TRANSPORT_ERROR`, `HTTP_ERROR`, and `INVALID_RESPONSE`, with an HTTP status
when available. An HTTP error also carries the Server's `errorCode` when it
sends one, such as `RAP_APP_CONFIG_REVISION_STALE` for a stale config revision.
Raw response bodies and transport causes are never included.

### `client.messages.send(request)`

Sends a message through the compatibility-stable v1 endpoint. Existing request
and response behavior is unchanged. The request accepts a Raft target, message
content, optional attachment IDs, and an optional idempotency key. Repeating a
send with the same idempotency key returns the original message; reusing the key
with a different target, content, or attachment set fails with HTTP 409
(`errorCode: "idempotency_key_reused"`). The result is a discriminated union:

- `ok: true` with a `sent` or `held` response.
- `ok: false` with a `transport`, `http`, or `validation` error.

### `client.messages.sendV2(request)`

Sends through the explicit v2 endpoint. In addition to the v1 fields, callers
can bind an authored handle to one visible actor with a typed mention:

```ts
await raft.messages.sendV2({
  target: "#feed-updates",
  content: "Please review this, @reader",
  mentions: [{
    type: "user",
    id: "11111111-1111-4111-8111-111111111111",
    name: "reader",
  }],
});
```

When an untyped handle is ambiguous or does not resolve, v2 still persists the
ordinary message without a mention edge and can return that handle in the
sender-only `unresolvedMentionHandles` warning. Use `sendV2` for typed actor
mentions and sender warnings; keep `send` when v1 byte and behavior
compatibility is required.

### `client.channels.join(request)`

Resolves a regular channel target such as `#engineering` through the
credential-authenticated Server info surface, then joins it through the typed
Agent API. The result reports `joined` or `already_joined`. Invalid targets,
invisible channels, transport failures, and Server rejections are returned as a
typed failure; the SDK does not weaken private or joint-channel membership.
