# @botiverse/raft-runtime-form

Released runtime form definitions and the rules for changing them.

## Runtime form contract versioning

The server sends agent create/edit forms (Built-in Pi, Kimi SDK) as a
versioned definition: `GET /api/servers/:id/machines/:machineId/runtime-form-definitions/:runtimeId`,
identified by `schemaVersion` (for example `builtin-pi.create.v3`). Installed
mobile builds parse that definition by version and refuse to render the whole
form when it differs from what they expect. Released mobile builds stay on
phones for a long time, so a released `schemaVersion` must never change shape.

This came out of the 2026-09-27/28 incidents: #8273 renamed a `dataSchema`
title without a version bump and the Built-in Pi form disappeared on iOS; the
fix was #8476, shipped as 1.18.3 (discussion `#raft-mobile-reconcile:3a0de29d`).

### Rule

A released `schemaVersion` is immutable. A change that makes the served
definition differ from that version's golden sample must either be reverted or
ship under a new `schemaVersion` with its own golden sample.

**Why everything counts as structure.** Mobile builds released before
mobile #2707/#2708 compare `dataSchema` titles, the field list, field order, required
fields, the advanced list and enum value sets literally (`botiverse/mobile`
`ComputersApi.kt`, `toBuiltInPiDomain`); #2707/#2708 relaxed titles only. Those
builds stay installed for months, so the golden sample freezes the whole
definition of a released version, `uiSchema.localization` text included, and
the server serves that sample verbatim.

**Where change goes instead.** New fields, copy and options go to a new version.
The planned v2 protocol (a generic renderer that tolerates unknown fields and
options, web first, then mobile) is where the form is meant to evolve; released
v1 versions stay frozen for the clients that still ask for them.

Option data is not frozen: provider display names and model catalogs change
with providers. A released Built-in Pi provider id must stay, because saved
agents and installed clients carry it; lists may grow.

### Golden samples

- Location: `packages/runtime-form/released/<schemaVersion>.json`.
- Content: the response body the released server sent, plus a `provenance`
  header recording `schemaVersion`, the release branch, the server commit and the
  capture date. A sample must trace to a released server.
- Serving: the server answers `GET runtime-form-definitions/:runtimeId` for a
  released version from this sample (`releasedRuntimeFormDefinition`), not from
  code, so later code changes cannot reach installed clients.
- Guards: `src/released.test.ts` checks every sample is registered with
  provenance; `packages/server/src/services/runtimeFormContract.test.ts` requires
  every version the server serves to have a sample and, until a new version is
  introduced, keeps the code builder equal to it so server-side validation stays
  aligned with the form clients render.

### When the contract test is red

Only two fixes are legal:

1. The change was unintended: revert it.
2. The change is intended: bump the `schemaVersion`, capture a new golden sample
   from the released server once it ships, and keep the old sample.

Rewriting an existing sample so the test passes defeats the guard. A reviewer
who sees an edited sample under `packages/runtime-form/released/` should reject the PR unless it
also bumps the version.

### Bumping a version

1. Add the new `schemaVersion` constant and change the definition.
2. Add its golden sample; keep the old one.
3. Coordinate with the mobile owner: released builds only accept the versions
   they know, and the server currently serves only the latest version (a stale
   `schemaVersion` query returns 409). Until version negotiation exists, a bump
   is a breaking change for installed builds and needs a mobile release first.
4. Name the version change and the affected fields in the PR description.

### Not covered yet

- Version negotiation: serving an older `schemaVersion` to the clients that ask
  for it. Needed before a bump can be non-breaking.
- Mobile-side check: the same golden samples run through the mobile parser in
  mobile CI, with a server-side check that the mobile copy matches (task #1217,
  with the mobile owners).

## Protocol v2

`GET /api/servers/:id/machines/:machineId/runtime-forms/v2/:runtimeId` returns
the current form, with no `schemaVersion` pin; option values come from
`…/runtime-forms/v2/:runtimeId/option-sources/:sourceId`. Producer:
`toRuntimeFormV2`; reference client parser: `parseRuntimeFormV2` (web uses it;
mobile mirrors it). Agreed in `#raft-mobile-reconcile:3a0de29d`.

The response still carries `schemaVersion` as a read-only label of which form
the server built (useful when debugging); v2 clients never pin or negotiate on
it.

Which runtimes have a v2 form: the server's v2 registry
(`packages/server/src/services/runtimeFormV2Registry.ts`), one entry per
runtime with its definition, option sources, form values ↔ runtimeConfig
mapping and write-only runtimeConfig secrets. Today: Built-in Pi, Kimi Code,
OpenCode, Codex, Grok, Claude, Cursor, Copilot, Pi, and the deprecated Kimi CLI, Gemini CLI and Antigravity CLI (edit
only: the admission row offers a deprecated runtime only as an agent's current
runtime, and a create with one is refused like any deprecated create). OpenCode
and Kimi CLI take their model list from the Computer's probe; when the probe is
not live (missing config, no models, unsupported, error, timeout, offline) the
option source is still a normal `select`, built from the bundled
`RUNTIME_MODELS` list as the legacy web form does. Gemini uses that list
directly. Antigravity picks its model itself: its form has only environment
variables and a save keeps the stored model. Codex and Grok (batch 3a) take
their model list from the probe too, but their forms list client capabilities
(item 7): each model option carries the reasoning efforts it allows, the effort
labels come from `choices`, the model source reports its `status`, and Codex
accepts a typed custom model. Grok's admission row (and so its v2 marker)
follows the Grok runtime feature flag. Claude, Cursor and Copilot (batch 3b)
follow the same pattern: all three take their model list from the Computer
(Claude's and Copilot's Computer answers with their declared static catalog,
Cursor's asks the Cursor CLI) and accept a typed custom model; Claude and
Copilot have a reasoning effort, Cursor none; Claude also has fast mode, a
Default/Custom provider select (a static `provider` source, no `status`) whose
Custom choice shows an API URL and a write-only API key, and an advanced Claude
Command. On edit a blank API key keeps the stored one while the API URL is
unchanged. The Claude key is write-only in the v2 form only: the v1 agent read
(`GET /api/agents/:id`) still returns it to editors, because installed mobile
apps prefill it from there and refuse to save a blank one
(`redactOnAgentRead: false` in the registry). Pi (batch 4, the Pi CLI
runtime, not Built-in Pi) has a provider select: Configured (the Computer's own
Pi auth.json) or a Pi built-in provider (today DeepSeek) with a write-only API
key. Configured takes its model list from the Computer's Pi probe and accepts a
typed custom model; a built-in provider offers only its own model list. The
contract has no select that both depends on another field and accepts a typed
value, so these are two fields, `model` (select) and `providerModel`
(dependent_select on `provider`), each shown for its provider and each with
its own reasoning effort field; both fill runtimeConfig.reasoningEffort. On
edit a blank key keeps the stored one while the provider is unchanged, and the
v1 agent read keeps returning the key, as for Claude. Pi has no saved provider
connections (the legacy form loads them only for Built-in Pi). Every runtime in
the catalog now has a v2 form. The runtime admission row
(`GET .../runtime-options`) carries `runtimeFormV2: { protocolVersion: 2 }` for
every registered runtime; web opens v2 by that marker (behind its flag). It is
independent of the row's v1 `formDefinitionRef`: a runtime can have a v2 form
and no v1 form, and then v1 clients never see it (the v1 routes 404 and the row
has no `formDefinitionRef`). Mobile asks the v2 endpoint directly and falls back
to v1 on 404.

Client obligations:

1. Tolerate: ignore unknown keys at every level; never reject the form for them.
2. Render by field kind, not name: `string` → text (`writeOnly` → secret,
   `format: "uri"` → URL); `boolean` → switch; `object` of strings → key/value
   editor; a field with `x-optionSource` → select, or dependent select when its
   source is `dependent_select`.
3. Order by `uiSchema.order`, then any remaining fields; `layout.advanced` goes
   under Advanced; apply `visibility`; label from `localization`, else `title`,
   else the key.
4. Unknown field kind: optional → skip it and keep its stored value; required →
   show the form, ask the user to update, and disable saving
   (`blockingFieldKeys`). Never drop the whole form.
5. Submit field values, not a runtimeConfig: `POST /api/agents` with
   `formDefinitionRef: { protocolVersion: 2, runtimeId }` and `formValues`
   keyed by `dataSchema` property name. The server assembles the runtimeConfig
   (`buildRuntimeConfigFromFormValues`) and validates it like a v1 request;
   errors point at `/formValues/<field>`, including ones found after assembly
   (the server rewrites `/runtimeConfig/...` pointers). On create the server
   ignores keys it does not assemble, so "send back unrendered values" only
   matters for edit.
6. Edit is the same form: `GET /api/agents/:id/runtime-form` returns the v2
   form plus `values`, the agent's current field values. writeOnly fields are
   never included; the client shows them blank and, on edit, a blank writeOnly
   field means "keep the stored value" (a changed provider with a blank secret
   is refused). Save with `PATCH /api/agents/:id`, same `formDefinitionRef` and
   `formValues` as create.

7. Required client capabilities: the form may list
   `requiredClientCapabilities: string[]`, capabilities the client must
   implement beyond the base renderer. Absent or `null` means `[]`. If the list
   contains a name the client does not implement, or the value is not an array,
   or an entry is not a string, the whole v2 form is unavailable to that client:
   fall back to the v1/legacy form, never render part of it
   (`missingRuntimeFormV2Capabilities`). Names, frozen (contract docs carry
   the full rules):
   - `select.custom_value`: `OptionSource.customValueAllowed` (kind `select`
     only; dependent_select keeps `customValueAllowedByValue`). Render a
     combobox: pick a listed option or type a value. The server stores a
     listed value as a preset and an unlisted one as a custom value; required
     still means non-empty. On edit a stored value that is not listed is shown
     and submitted as typed, never reported as not-a-choice.
   - `choice.labels`: `FieldCopy.choices` (`{ label, description? }` by option
     value) for `select` and `derived_select`. Label: `choices[value].label`,
     else the option's `label`, else the raw value; `description` only from
     `choices`; keys matching no option are ignored.
   - `option_source.status`: `OptionSource.status` (`live` | `fallback` |
     `unavailable`), `reason` (`probe_timeout`, `probe_failed`,
     `missing_config`, `no_models`, `unsupported`, `machine_offline`; absent
     when live) and `retryable` (absent/false when live). One status per source,
     worst wins (unavailable > fallback > live), dependent_select included.
     `unavailable` has no options. A required field whose source is unavailable
     shows the status (and a retry when `retryable`) and blocks submit; an
     optional one is hidden. Retry re-requests the same source with
     `?refresh=1` (the server bypasses any cache; it keeps none today). A
     source-level failure never sends a client back to v1: that is only for a
     form-level 404 or protocol error.

   The server sends these fields only on the v2 endpoints and only to forms
   that list the capability: a form without it (Built-in Pi, Kimi Code,
   OpenCode, Kimi CLI, Gemini, Antigravity) gets its option sources exactly as
   before, typed 409s included (per registry entry, not by inspecting the
   request). Today Codex, Claude, Copilot and Pi list all three, Grok lists
   `choice.labels` and `option_source.status`, and Cursor lists
   `select.custom_value` and `option_source.status`. Web implements all three
   (`WEB_RUNTIME_FORM_V2_CAPABILITIES`).

   How the server maps the Computer's model probe
   (`packages/server/src/services/runtimeFormV2SourceStatus.ts`):

   | probe outcome | reason | retryable |
   |---|---|---|
   | live with models | (status `live`) | (absent) |
   | missing_config | missing_config | false |
   | no_models, or live with no models | no_models | true |
   | unsupported | unsupported | false |
   | error `detect_timeout`, or the server's wait timed out | probe_timeout | true |
   | error `computer_offline`, Computer not routed / socket not ready | machine_offline | true |
   | any other error or thrown failure | probe_failed | true |

   Codex, Grok, Claude, Cursor, Copilot and Pi serve the bundled model list as
   `fallback` whenever the probe is not live, so `unavailable` only happens for
   a runtime with no bundled list. The legacy form does the same for all but
   Pi: its Configured list then offers only a typed model, while v2 also offers
   Pi's bundled "Configured Default / Auto" entry. Pi's provider and
   built-in-provider model sources are static and carry no `status`.

   Submitting a reasoning effort: the ordinary validation only knows the
   bundled models, and drops an effort a model does not declare there. A v2
   submit for these runtimes therefore asks the Computer once more: when the live
   list names the selected model, its option decides (the effort is kept if
   offered, refused at `/formValues/reasoningEffort` if not, and the model is
   stored as a preset); otherwise the static rule stands.

The server may add optional fields, change copy, add options or enum values and
reorder. A new required field or a new field kind is breaking: ship it behind a
`requiredClientCapabilities` name so older clients fall back instead of
rendering a form they cannot complete. The server remains the validator.

### Generated wire types

`contract/runtime-form-v2.contract.json` is the single source for the v2 wire
shape (artin, `#raft-mobile-reconcile:3a0de29d`). `pnpm --filter
@botiverse/raft-runtime-form contract:generate` writes:

- `src/generated/runtimeFormV2.ts`: TypeScript types for the server and web;
- `generated/kotlin/RuntimeFormV2.kt`: kotlinx.serialization data classes for
  mobile (decode with `ignoreUnknownKeys = true`; enumerated strings stay
  `String` so an unknown value never fails decoding);
- `generated/runtime-form-v2.schema.json`: JSON Schema, used by
  `src/contract.test.ts` to check every released form served over v2.

The package test fails when a generated file is stale. What is generated is the
protocol, not each form: form contents stay server data delivered at runtime.

## Shared v2 fixtures

`fixtures/<runtime>.form.json` and `fixtures/<runtime>.edit.json` are the exact
bodies the server sends today for the v2 create form
(`GET /api/servers/:id/machines/:machineId/runtime-forms/v2/:runtimeId`) and for
editing (`GET /api/agents/:id/runtime-form`, with `values`; writeOnly fields are
never included). Web and mobile test their v2 parsing and form state against
these files instead of converting v1 samples themselves, so every client follows
one source.

`<runtime>.option-source.fallback.json` is the option-source body
(`…/runtime-forms/v2/:runtimeId/option-sources/model`) a live-probed runtime
(OpenCode, Kimi CLI) returns when the probe is not live; `gemini.option-source.json`
is Gemini's static list. The deprecated runtimes have only `.edit.json`.

Batch 3a adds `codex.form.json`, `codex.edit.json` (a stored custom model),
`grok.form.json` and `codex.option-source.{live,fallback,unavailable}.json`
(the model source with `option_source.status`; `unavailable` is the shape the
server builds when a probe fails and there is no bundled list, which Codex
always has today).

Batch 3b adds `claude.form.json`, `claude.edit.json` (a Custom provider; the
stored key is not in `values`), `cursor.form.json`, `cursor.edit.json` (a stored
custom model), `copilot.form.json`, `claude.option-source.provider.json` (the
static provider select), `claude.option-source.fallback.json` (Computer
offline), `cursor.option-source.fallback.json` (missing config) and
`copilot.option-source.live.json` (the declared static catalog).

Batch 4 adds `pi.form.json`, `pi.edit.json` (a DeepSeek provider; the stored
key is not in `values`), `pi.edit.configured.json` (Configured with a typed
custom model), `pi.option-source.provider.json` (the static provider select),
`pi.option-source.provider-model.json` (the built-in providers' model lists,
a dependent_select) and `pi.option-source.fallback.json` (the Configured model
list when the Pi probe reports missing config).

`capabilities.form.json` is the exception: a hand-written sample (not served by
any runtime) of a form that lists `requiredClientCapabilities`, for clients to
test the fallback rule against; `src/contract.test.ts` checks it against the
contract. `choices.form.json` with `choices.option-source.json` is the
hand-written `choice.labels` sample (label priority, a description, an unknown
key, a missing key); the contract test byte-locks both.

`packages/server/src/services/runtimeFormV2Fixtures.test.ts` keeps the
per-runtime files equal to the server's current output. When it goes red the server's v2 output changed:
regenerate with `UPDATE_RUNTIME_FORM_FIXTURES=1 pnpm --filter @botiverse/raft-server exec vitest run src/services/runtimeFormV2Fixtures.test.ts`
and treat the diff as a client-visible change. Clients that embed a copy (mobile
commonTest) record the source file's sha256 and check it against this directory.
