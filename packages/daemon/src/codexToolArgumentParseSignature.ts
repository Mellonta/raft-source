/**
 * task #1127 — the one sanctioned stderr text signature in the Codex driver.
 *
 * Everything else in this daemon classifies failures by typed code, never by
 * message text (see `spawnFailureErrors.ts` and `spawnFailureClassification.ts`).
 * This file is the deliberate exception, and it is isolated in its own module so
 * that the exception stays greppable and reviewable rather than dissolving into
 * the general stderr handling.
 *
 * Why text is the only evidence here: when Codex's tool router cannot
 * deserialize the arguments the model produced for a tool call, it emits a Rust
 * `tracing` line on stderr from target `codex_core::tools::router` and then
 * continues. No app-server notification carries the fact — the failed tool item
 * still arrives shaped like progress — so the daemon's structured event stream
 * cannot see it and the agent looks idle to the user. Upstream:
 * openai/codex#33452 (open).
 *
 * The signature is therefore evidence acquisition, not a second classifier: it
 * converts a text observation into the typed `ToolArgumentParseError` code, and
 * every downstream decision is made on that code.
 *
 * Scope, deliberately narrow:
 *  - IN:  a tool-argument deserialization failure reported by the tool router.
 *  - OUT: every other error the same router reports. `write_stdin failed` rides
 *         the identical target and is owned by `isStdinClassRecoveryLine`;
 *         matching the target alone would reclassify a stdin bug as a model
 *         output-format problem and tell the user to change models.
 *  - OUT: the same parse sentence from any other tracing target.
 *
 * If Codex ever emits a structured event for this, that event must win and this
 * signature should become dead code — delete it rather than keeping both.
 */

/**
 * Verbatim upstream line from the originating incident: artin's Mac,
 * 2026-09-14T19:18:44Z, Codex CLI 0.153.4 via a custom OpenAI-compatible
 * provider. Pinned so the predicate is always tested against a sentence Codex
 * actually emitted rather than one we invented.
 */
export const CODEX_TOOL_ARGUMENT_PARSE_UPSTREAM_FIXTURE =
  "ERROR codex_core::tools::router: error=failed to parse function arguments: invalid type: floating point 14380.0, expected i32";

/**
 * The invariant halves of that line. The serde tail (`invalid type: floating
 * point 14380.0, expected i32`) is a function of the model's output and is
 * intentionally not part of the signature — and never recorded, since it can
 * contain argument values.
 *
 * Both literals were read out of the shipped Codex binary (`codex_core::tools::router`
 * as a tracing target emitted from `core/src/tools/router.rs`, and the sentence
 * `failed to parse function arguments: `), and both are present as far back as
 * codex-cli 0.144.6, so the signature is not pinned to a single release.
 */
const CODEX_TOOL_ROUTER_TRACING_TARGET = "codex_core::tools::router";
const CODEX_TOOL_ARGUMENT_PARSE_SENTENCE = "failed to parse function arguments:";

/**
 * True when a Codex stderr chunk reports a tool-argument parse failure.
 *
 * Takes a *chunk*, not a line: `drivers/runtimeSession.ts` attaches stderr with
 * a bare `chunk.toString().trim()` — no decoder and no newline buffering — so a
 * single emission can carry several lines. Both halves of the signature must
 * appear on the same line, so that an unrelated router error and an unrelated
 * parse failure arriving in one chunk cannot combine into a false positive.
 */
export function isCodexToolArgumentParseErrorChunk(text: string): boolean {
  if (!text) return false;
  return text.split(/\r?\n/).some((line) =>
    line.includes(CODEX_TOOL_ROUTER_TRACING_TARGET)
    && line.includes(CODEX_TOOL_ARGUMENT_PARSE_SENTENCE)
  );
}
