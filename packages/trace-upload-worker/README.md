# Slock Trace Upload Service

Upload and ingest service for **client diagnostics**. Despite the name it does
two unrelated jobs that share one shape — a client uploads a diagnostic blob
under a Raft-server-signed attestation, the service verifies it and stores it
in R2:

| Job | Caller | Endpoints | Stored in R2 | Read by |
| --- | --- | --- | --- | --- |
| **Trace ingest** | daemon / Computer (trace bundles), browser (trace batches) | `POST /api/trace-bundles` (+ `PUT …/object`), `POST /api/web-traces` | `trace-bundles/<serverId>/<machineId>/…`, `trace-ledgers/…` | this service itself forwards spans/events as OTLP to Telescope / ScopeDB |
| **Feedback report uploads** | browser Report Issue dialog; daemon follow-ups (runtime transcript, machine log tail) arrive as trace bundles carrying a `feedbackReportId` | `POST /api/reports` (+ `PUT …/object`, `POST …/complete`) | `feedback-reports/<serverId>/<reportId>/…`; index under `feedback-report-ledgers/<serverId>/<reportId>/` | lens (`botiverse/lens`), which syncs that prefix; the user-facing ticket lives in Hands |

It runs as a Node service (`src/node.ts`) on AWS ECS in staging, play, and
production; uploads land in R2 through the S3-compatible API and OTLP ingest
goes over private Cloud Map DNS to Telescope. Local development (`raftdev`)
runs the same entry against the local RustFS bucket. The Slock server is
control plane only: it signs upload attestations and never relays payloads.
The service never calls lens or any other internal tool — readers pull from R2.

The name predates the feedback job. Package, image, and infrastructure names
(`raft-trace-upload-*`, terraform `module.trace_upload`) are kept as is;
renaming them would recreate production resources.

## Storage layout

Both jobs share **one R2 bucket** (production: `slock-daemon-trace-bundles-prod`)
and one set of credentials; they are isolated logically by key prefix:

| Prefix | Written by | Holds |
| --- | --- | --- |
| `trace-bundles/<serverId>/<machineId>/<uploadId>…` | trace bundle upload | raw daemon / Computer trace bundles, **including** a report's runtime transcript and machine log tail |
| `trace-ledgers/<serverId>/<machineId>/<uploadId>.json` | trace bundle upload | per-bundle ledger (R2 + OTLP ingest status) |
| `feedback-machine-evidence/<serverId>/<machineId>/<uploadId>.json.gz` | trace bundle upload (`feedbackAttachmentKind: machine_evidence`) | one report's machine evidence: observed-failure summary, trace-tail projection, machine state (one gzipped JSON object, ≤ 256 KiB raw; never OTLP-ingested) |
| `feedback-transcript-outcomes/<serverId>/<machineId>/<uploadId>.json.gz` | trace bundle upload (`feedbackAttachmentKind: transcript_outcome`) | one feedback transcript request's typed lookup/upload outcome (one gzipped JSON object, ≤ 2 KiB raw; never OTLP-ingested; never under `trace-bundles/`) |
| `feedback-reports/<serverId>/<reportId>/<artifactId>/…` | feedback report upload | the browser's Report Issue bundle |
| `feedback-report-ledgers/<serverId>/<reportId>/` | both | the report index: `<artifactId>.json`, `<artifactId>.complete.json`, and `trace-<uploadId>.json` for each trace bundle attested with that `feedbackReportId` |

The one place the two jobs meet: a report's transcript and log tail are
uploaded by the daemon **as trace bundles** (they live under `trace-bundles/`
next to every machine's routine traces) and are tied to the report only by
`feedbackReportId`. That is why the trace bundle upload also files their ledger
under the report's index folder. The key format is owned by
`src/feedback/ledgerKeys.ts`.

## Code layout

```
src/
  index.ts              HTTP routing only
  node.ts               runtime entry (production and raftdev)
  env.ts                env + R2-shaped storage interface
  shared/               attestations & upload tokens, request/CORS helpers,
                        transcript-coverage facts (used by both jobs)
  traces/               trace bundles, web traces, OTLP forwarding, V2 projection
  feedback/             Report Issue uploads and the report index key layout
```

`traces/` depends on `feedback/` only for `ledgerKeys.ts`; `feedback/` does not
depend on `traces/`.

Trace bundle contract:
- `POST /api/trace-bundles` accepts a server-signed `daemon-trace-bundle:create` attestation.
- The service trusts `uploadId`, `objectKey`, `bundleSha256`, `bundleSizeBytes`, and `maxBytes` only from signed attestation metadata.
- The service trusts `deploymentEnvironment` only from signed attestation metadata when present. The signing side should derive this from the daemon's configured server URL / server deployment (`staging` server URL -> `staging`, production server URL -> `production`) instead of relying on the service's own deployment environment.
- The service returns a short-lived `PUT` URL under the same upload endpoint.
- The `PUT` path verifies the upload token, bundle size, and SHA-256 before writing to R2.
- If `TRACE_INGEST_OTLP_ENDPOINT` is configured, the service schedules a best-effort background ingest after a successful R2 write: it reads the just-written bundle back from R2, validates daemon trace JSONL `schema_version: 1`, converts spans to OTLP/HTTP JSON, and posts to ScopeDB/Telescope. Ingest failure does not fail upload; R2 remains the raw replay source.
- The same service writes a lightweight ledger JSON under `trace-ledgers/<serverId>/<machineId>/<uploadId>.json` so staging/prod can reconcile `r2_status` and `scopedb_status` without a second Worker or queue.
- Feedback reports are indexed in R2 itself; nothing is pushed to another service. Everything one report produced is listed under `feedback-report-ledgers/<serverId>/<reportId>/`: the browser bundle's `<artifactId>.json` / `<artifactId>.complete.json`, and, for each daemon trace bundle attested with that `feedbackReportId` (runtime transcript, machine log tail), `trace-<uploadId>.json` — a byte-identical copy of its `trace-ledgers/` ledger, rewritten on every status update. Its `feedback_attachment_kind` (`session_transcript` | `machine_log_tail` | `machine_evidence` | `transcript_outcome`, from the signed attestation) tells the attachments apart. Readers (the internal diagnostics tool, lens) list that prefix; they never scan `trace-ledgers/` or `trace-bundles/`.
- `machine_evidence` (feedback diagnostics) is its own object with its own attestation, never part of the transcript's: the attestation length gate (`SCOPE_ATTESTATION_MAX_CHARS`, shared with the server, 16 KiB) runs before verification, and diagnostics inside it used to make the transcript upload fail. On PUT the object is gunzipped under the 256 KiB raw cap (413 over), strictly parsed with the shared parser, and its report/agent must equal the signed claims; it is filed in both ledgers with `scopedb_status: "skipped"` and is never OTLP-ingested or re-ingested. Create echoes the signed `feedbackAttachmentKind`; a daemon does not upload a kind the worker did not acknowledge, and a signed kind this worker does not know is a 400.
- `transcript_outcome` (task #1228 ①) is the typed outcome of one feedback transcript request (`{type: "feedback_transcript_outcome", schemaVersion: 1, feedbackReportId, agentId, requestId, daemonVersion, generatedAt, lookup, upload, selfStorage: "not_self_attested"}`, strict shared parser `parseFeedbackTranscriptOutcome`). Create requires report + agent + `feedbackTranscriptRequestId` binding and gzipped JSON; PUT gunzips under the 2 KiB raw cap, strictly parses, and checks report/agent/request against the signed claims. Filed in both ledgers (`scopedb_status: "skipped"`), never OTLP-ingested or re-ingested. Its object key is outside `trace-bundles/`, so a reader that validates `object_key` against `trace-bundles/<serverId>/` before classifying skips it. `generatedAt` is a display/sort hint only. The object never claims its own storage: its ledger entry is the evidence.
- Transcript bundles from daemons with task #1228 ① carry signed `feedbackTranscriptContent` (`native_session_file` | `native_state_file`; a daemon placeholder is never uploaded), `feedbackTranscriptSourceBytes`, `feedbackTranscriptBytes` and `feedbackTranscriptRequestId`, read independently of the coverage claims and filed in the ledger as `transcript_content`, `transcript_source_bytes` (source file size on disk at read time), `transcript_bytes` (uncompressed bytes uploaded after windowing/redaction; a difference is NOT by itself truncation) and `request_id`. An entry WITHOUT `transcript_content` (older daemon/server/worker) is source-unverified — it may be a daemon placeholder — and its request association is unknown; readers must never default it to native (`classifyFeedbackReportLedgerEntry` in shared). Fixture: `src/testing/fixtures/feedback-report-ledger.transcript-outcome.json`.
- Ingest is at-least-once, not exactly-once. Replays/retries may append duplicate raw OTLP rows, so every imported daemon span includes `slock.trace_ingest.span_key = serverId:machineId:bundleSha256:trace_id:span_id`. ScopeDB/Telescope analysis and future materialized views must dedupe on that key. `uploadId` remains an attempt/session diagnostic field, not span identity.
- With `RAFT_TRACE_SCOPEDB_PROJECTOR=on`, the authenticated collector also projects each accepted web/daemon span into the typed Trace V2 table after the canonical OTLP write. It emits one `event` row per event and one `span_fact` row per completed span through the shared closed-schema helpers. This is a reversible shadow: V2 failure is reported in the web response or daemon ledger but never fails a successful OTLP write. Record validation is isolated per span, so one malformed span cannot erase valid siblings; partial projection remains fail-visible through projected/skipped counts plus the fixed `TraceProjectionRecordValidationError` reason class. If OTLP is disabled, V2 refuses to run so the projector cannot silently become a B-only trace path.
- V2 uses committed one-shot ScopeDB SDK writes at the request/R2 batch boundary. It has no process-local durability and remains decision-support data. Unknown attrs are ignored; only the shared promoted allowlist and explicit camelCase identity aliases reach typed columns. `machine_id` is correlation identity, not `service_instance_id`.

Node service required secrets/vars:
- Secret: `SCOPE_ATTESTATION_SECRET` (must match the Slock server signer)
- Secret: `R2_ACCESS_KEY_ID`
- Secret: `R2_SECRET_ACCESS_KEY`
- Var: `R2_ENDPOINT` (Cloudflare R2 S3 endpoint, for example `https://<account-id>.r2.cloudflarestorage.com`)
- Var: `R2_BUCKET` (staging/prod bucket name)
- Var: `TRACE_INGEST_OTLP_ENDPOINT` (AWS staging points to `http://telescope.raft-staging.local:4318/v1/traces`)
- Optional secret: `TRACE_UPLOAD_WORKER_SECRET` (defaults to `SCOPE_ATTESTATION_SECRET`)
- Optional var: `R2_REGION` (defaults to `auto`)
- Optional var: `TRACE_UPLOAD_MAX_BYTES` (defaults to 50MB)
- Optional var: `TRACE_INGEST_OTLP_AUTHORIZATION` (Authorization header for the OTLP endpoint)
- Optional var: `TRACE_INGEST_SERVICE_NAME` (defaults to `slock-daemon`)
- Optional var: `TRACE_INGEST_BATCH_SIZE` (defaults to 128 spans/request)
- Optional var: `TRACE_INGEST_MAX_DECOMPRESSED_BYTES` (defaults to 100MB)
- Optional var: `DEPLOYMENT_ENV` (fallback only when signed attestation metadata omits `deploymentEnvironment`)
- Optional var: `RAFT_TRACE_SCOPEDB_PROJECTOR` (`on` enables the typed V2 shadow; unset/`off` skips it)
- V2 secret: `SCOPEDB_TRACE_EVENTS_WRITE_KEY` (required when the projector is `on`)
- V2 var: `SCOPEDB_TRACE_EVENTS_ENDPOINT` (required when the projector is `on`; the statement is code-owned)

Daemon upload client:
- Enable with `SLOCK_DAEMON_TRACE_UPLOAD_URL=<trace-upload-service-url>`.
- The daemon uploads only closed local JSONL trace files from `~/.slock/machines/<machine>/traces`; it skips the currently open file and marks successfully uploaded files with a local sidecar under `trace-uploads/`.
- Optional daemon vars: `SLOCK_DAEMON_TRACE_UPLOAD_INTERVAL_MS` (default 5 minutes) and `SLOCK_DAEMON_TRACE_UPLOAD_MIN_FILE_AGE_MS` (default 60 seconds).
