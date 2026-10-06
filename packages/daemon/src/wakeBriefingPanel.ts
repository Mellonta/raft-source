import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AxSurfaceText } from "@botiverse/raft-shared";
import { indentAgentBodyContinuationLines } from "@botiverse/raft-shared";
import { axSurface } from "./agentRuntimeInput";

/**
 * RFC 070 constructed wake panel (the "v3" arm from §9): built at recycle
 * time from the retired session's transcript tail plus live re-reads of the
 * objects still on disk. The transcript is used as the ACTION LOG (what was
 * tried, what failed), never replayed verbatim; file contents are re-read
 * from the world when possible so the panel shows current state, and content
 * that could not be re-read is labeled with when it was last observed.
 *
 * Evaluation note (2026-09-12): the original offline metrics (entity recall,
 * open-loop retention) and the live jury rubric rewarded prior-work
 * orientation and are superseded. The standard now is behavioral equivalence
 * with real full-context continuations at idle boundaries — in 1,301 such
 * continuations: ~8% opened with a ritual, ~20% touched a prior unresolved
 * failure early, ~8% redid a succeeded command. A construction is good when
 * an agent given it behaves like that distribution, message-first.
 */

const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
const DEFAULT_PANEL_BUDGET_TOKENS = 8_000;
const OBJECT_CONTENT_CAP_TOKENS = 700;
const RECENT_ACTIONS = 12;
const REREAD_FILE_MAX_BYTES = 64 * 1024;
const RECENT_MESSAGES_DEFAULT = 25;
const MESSAGE_MAX_TOKENS = 2_000;
const MESSAGES_SECTION_CAP_TOKENS = 4_000;
/** Messages are cheap to scan (line grep, no JSON semantics needed beyond
 * chunking), so their harvest window is deeper than the action window. */
const MESSAGE_SCAN_TAIL_BYTES = 16 * 1024 * 1024;
const STALE_OBJECT_BODY_CAP_TOKENS = 300;
/** Objects last touched longer ago than this before the session's final
 * action are "out of play": they render as bare pointers with no body. In a
 * real full context, hours-old work is diluted across hundreds of thousands
 * of tokens; a 10k panel concentrates it, so an old note's "Next step:" line
 * gains salience it never had and reads as a live agenda (the R1 bench's
 * dominant misdirection). */
const OBJECT_IN_PLAY_WINDOW_MS = 2 * 3_600_000;
/** Fallback in-play gate (by action index) for transcripts without usable
 * timestamps. */
const OBJECT_IN_PLAY_ACTIONS = 40;
const MAX_PANEL_OBJECTS = 14;

/** Never inject these files' contents into a constructed panel, from either
 * source (live re-read or transcript residue): a workspace routinely holds
 * credentials the retired session read legitimately in place. */
const SENSITIVE_PATH_RE = /(secret|credential|password|token|\.key$|\.pem$)/i;

const FAIL_RE = /(exit code [1-9]|error|Error|ERROR|not found|No such file|failed|Failed|Traceback|refus)/;
const MUTATING_RE = new RegExp(
  "(^|[;&|]\\s*)(rm|mv|cp|mkdir|touch|sed\\s+-i|tee|git\\s+(commit|add|checkout|stash|reset|push)|"
  + "npm\\s+(i|install|run)|pnpm\\s+(i|install|add|run)|pip\\s+install|docker\\s+(run|rm|build)|"
  + "cargo\\s+|make\\b|chmod|ln\\s|raft\\s+(message\\s+send|task\\s+(claim|create|update|done)))|>>?\\s*\\S",
);

export interface TranscriptAction {
  i: number;
  tool: string;
  input: Record<string, unknown>;
  result: string;
  ok: boolean;
  mutating: boolean;
  ts: string | null;
}

function tokens(text: string): number {
  return Math.max(1, Math.floor((text.length + 3) / 4));
}

function elide(text: string, limit: number): string {
  const flat = (text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, Math.max(0, limit - 1))}…`;
}

function callForm(action: TranscriptAction, valueWidth = 44): string {
  const parts = Object.entries(action.input)
    .filter(([key]) => key !== "description")
    .map(([key, value]) => `${key}=${elide(typeof value === "string" ? value : JSON.stringify(value ?? ""), valueWidth)}`);
  return `${action.tool}(${parts.join(" ")})`;
}

/** The raft CLI's display clock ("YYYY-MM-DD HH:MM:SSZ"). Every timestamp
 * the panel renders itself uses this one format, so action lines, sent lines
 * and received messages cross-reference without translation. */
function cliClock(ts: string | null): string | null {
  if (!ts || !Number.isFinite(Date.parse(ts))) return null;
  return new Date(ts).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function actionLine(action: TranscriptAction): string {
  const mark = !action.ok ? " !" : action.mutating ? " *" : "  ";
  const result = action.result ? ` → ${elide(action.result, 60)}` : "";
  // Dated in the same clock as the messages section: undated action lines
  // left a judge unable to tell which daily-maintenance cycle was current
  // (R2 bench, b0), and a second format would reintroduce the clock-style
  // mismatch fixed in R3.
  const when = cliClock(action.ts);
  return `s${String(action.i).padEnd(5)}${mark} ${when ? `${when} ` : ""}${callForm(action)}${result}`;
}

/** Read the transcript tail as JSONL lines (partial first record dropped). */
async function readTranscriptTailLines(
  transcriptPath: string,
  tailBytes: number,
): Promise<string[] | null> {
  let text: string;
  let droppedHead = false;
  try {
    const info = await stat(transcriptPath);
    const readStart = Math.max(0, info.size - tailBytes);
    droppedHead = readStart > 0;
    const fd = await open(transcriptPath, "r");
    try {
      const buffer = Buffer.alloc(info.size - readStart);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const result = await fd.read(buffer, bytesRead, buffer.length - bytesRead, readStart + bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fd.close();
    }
  } catch {
    return null;
  }
  const lines = text.split("\n");
  if (droppedHead) lines.shift(); // partial first record in a mid-file window
  return lines;
}

/** Parse the transcript tail into ordered tool actions (call + result). */
export async function parseTranscriptActions(
  transcriptPath: string,
  tailBytes: number = TRANSCRIPT_TAIL_BYTES,
): Promise<TranscriptAction[]> {
  const lines = await readTranscriptTailLines(transcriptPath, tailBytes);
  if (lines === null) return [];

  const calls = new Map<string, { tool: string; input: Record<string, unknown>; ts: string | null }>();
  const results = new Map<string, { text: string; isError: boolean }>();
  const order: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = record.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    if (record.type === "assistant") {
      for (const block of content) {
        if (block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_use") {
          const b = block as Record<string, unknown>;
          const id = typeof b.id === "string" ? b.id : null;
          if (!id) continue;
          calls.set(id, {
            tool: typeof b.name === "string" ? b.name : "?",
            input: (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>,
            ts: typeof record.timestamp === "string" ? record.timestamp : null,
          });
          order.push(id);
        }
      }
    } else if (record.type === "user") {
      for (const block of content) {
        if (block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_result") {
          const b = block as Record<string, unknown>;
          const id = typeof b.tool_use_id === "string" ? b.tool_use_id : null;
          if (!id) continue;
          const value = b.content;
          const resultText = typeof value === "string"
            ? value
            : Array.isArray(value)
              ? value.map((x) => (x && typeof x === "object" ? String((x as Record<string, unknown>).text ?? "") : "")).join(" ")
              : "";
          results.set(id, { text: resultText, isError: b.is_error === true });
        }
      }
    }
  }

  const actions: TranscriptAction[] = [];
  order.forEach((id, index) => {
    const call = calls.get(id);
    if (!call) return;
    const result = results.get(id) ?? { text: "", isError: false };
    const command = typeof call.input.command === "string" ? call.input.command : "";
    actions.push({
      i: index,
      tool: call.tool,
      input: call.input,
      result: result.text,
      ok: !(result.isError || FAIL_RE.test(result.text.slice(0, 400))),
      mutating: call.tool === "Edit" || call.tool === "Write" || MUTATING_RE.test(command),
      ts: call.ts,
    });
  });
  return actions;
}

/** One message the retired session saw or sent. Received messages keep the
 * raft CLI's own display rendering VERBATIM (`[target=… msg=… time=…] @… : …`)
 * — the format agents already read every day — so the panel splices rather
 * than re-renders. Only sent messages are synthesized (the transcript holds
 * the send command, not a display form). */
export interface PanelMessage {
  /** The display text, ready to splice into the panel. */
  raw: string;
  /** `msg=` id when present; dedupe key. */
  msgId: string | null;
  /** Parsed `time=` attribute (or send timestamp); sort key. */
  ts: string | null;
  self: boolean;
}

const SEND_COMMAND_RE = /\braft\s+message\s+send\b/;
const MSG_ATTR_RE = /\bmsg=([\w-]+)/;
const TIME_ATTR_RE = /\btime=([0-9T:\- ]+Z?)/;
/** Ephemeral system chrome: reminder firings and catch-up notices describe a
 * past MOMENT, not durable conversation — a stale copy near the bottom of the
 * scrollback reads as a live obligation (top misdirection in the gold bench).
 * Informative system messages (task assignments etc.) stay. */
const EPHEMERAL_SYSTEM_RE = /@system[^\n]*(reminder|Next iteration|catch-?up)|^\[system reminder/im;

/** Split a block of text into per-message chunks at `[target=` line starts,
 * keeping each chunk's text verbatim (continuation lines included). */
export function parseMessageChunks(text: string): PanelMessage[] {
  const out: PanelMessage[] = [];
  let current: string[] | null = null;
  const finalize = () => {
    if (!current) return;
    let raw = current.join("\n").replace(/\s*No more new (?:inbox )?messages\.\s*$/, "").trimEnd();
    if (raw.length > 0
      && !/@system[^\n]*stopped following this thread/.test(raw)
      && !EPHEMERAL_SYSTEM_RE.test(raw)) {
      out.push({
        raw,
        msgId: MSG_ATTR_RE.exec(current[0]!)?.[1] ?? null,
        ts: TIME_ATTR_RE.exec(current[0]!)?.[1]?.trim() ?? null,
        self: false,
      });
    }
    current = null;
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("[target=")) {
      finalize();
      current = [line];
    } else if (/^No more new (?:inbox )?messages\.?$/.test(line.trim())) {
      // CLI end-of-listing trailer: closes the chunk so that whatever the
      // surrounding tool output prints next (progress notes, echo debris)
      // is never absorbed as message continuation lines.
      finalize();
    } else if (current && current.length < 80 && line.trim().length > 0) {
      current.push(line);
    } else if (current) {
      finalize();
    }
  }
  finalize();
  return out;
}

/** Extract the sent body from a `raft message send` command string: heredoc
 * first (the CLI guide recommends it; the delimiter line may carry a trailing
 * pipeline, `<<'SLOCKMSG' 2>&1 | tail -8`), then the longest quoted argument.
 * Returns null when the command carries no body at all (e.g. a bare
 * `--send-draft` resend, whose body lives in the guard-blocked attempt). */
export function parseSentMessage(command: string, ts: string | null): PanelMessage | null {
  const target = /--target[=\s]+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  if (!target) return null;
  // An unexpanded shell variable as the target means the transcript cannot
  // tell us who received it — and the surrounding compound command's quoted
  // strings (grep patterns, echoes) are then the only body candidates.
  if ((target[1] ?? target[2] ?? target[3] ?? "").includes("$")) return null;
  // A draft resend never carries a new body; quoted strings elsewhere in a
  // compound command (`…; echo "---"; raft inbox check`) must not be mistaken
  // for one.
  if (/--send-draft\b/.test(command)) return null;
  let body: string | null = null;
  const heredoc = /<<-?\s*['"]?([A-Za-z_][\w]*)['"]?[^\n]*\n([\s\S]*?)\n\1(?:\s|$)/.exec(command);
  if (heredoc) {
    body = heredoc[2]!;
  } else {
    // Scan only the send invocation itself, not later commands in a pipeline:
    // cut at the first unquoted `;`, `|`, or newline (a grep pattern after a
    // pipe is a convincing fake body).
    let cut = command.slice(command.search(SEND_COMMAND_RE));
    let quote: string | null = null;
    for (let i = 0; i < cut.length; i += 1) {
      const ch = cut[i]!;
      if (quote) {
        if (ch === quote) quote = null;
        else if (ch === "\\" && quote === '"') i += 1;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ";" || ch === "|" || ch === "\n") {
        cut = cut.slice(0, i);
        break;
      }
    }
    const sendSegment = cut.replace(target[0], "");
    let longest = "";
    for (const match of sendSegment.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) {
      const candidate = match[1] ?? match[2] ?? "";
      if (candidate.length > longest.length) longest = candidate;
    }
    body = longest.length > 0 ? longest : null;
  }
  if (body === null || body.trim().length === 0) return null;
  const targetName = target[1] ?? target[2] ?? target[3] ?? "?";
  // The CLI display clock, not raw transcript ISO: a sent line whose clock
  // format differs from its received neighbors reads as a timezone mismatch
  // and makes a correct interleave look mis-sorted (R2 bench, b0).
  const displayTs = cliClock(ts) ?? ts;
  // Only the reconstructed body (and the target token) are ours to prefix.
  // Received lines elsewhere in this panel are copied from earlier tool output
  // that the CLI already rendered; prefixing them again would double the
  // marker and would not repair pre-fix lines (HaoHao, task #362 review).
  return {
    raw: `[target=${indentAgentBodyContinuationLines(targetName)}${displayTs ? ` time=${displayTs}` : ""}] you sent: ${indentAgentBodyContinuationLines(body.trim())}`,
    msgId: null,
    ts,
    self: true,
  };
}

/**
 * Reconstruct the messages the retired session recently saw or sent, from its
 * transcript tail: `raft message check/read/search` tool results, message
 * bodies carried by wake inputs, and `raft message send` commands (rendered
 * first-person). Deduplicated by message id, newest `max` kept, transcript
 * order preserved. A lossy view by construction — the section header says so.
 */
export async function collectRecentMessages(
  transcriptPath: string,
  max: number,
  tailBytes: number = MESSAGE_SCAN_TAIL_BYTES,
): Promise<PanelMessage[]> {
  const lines = await readTranscriptTailLines(transcriptPath, tailBytes);
  if (lines === null) return [];

  // Send attempts pair with their tool results: a guard-blocked attempt holds
  // the body, the follow-up `--send-draft` confirms delivery. Only confirmed
  // sends are listed as the agent's own words.
  const sendAttempts = new Map<string, { message: PanelMessage | null; target: string | null }>();
  const pendingDraftByTarget = new Map<string, PanelMessage>();
  const found: PanelMessage[] = [];
  for (const line of lines) {
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof record.timestamp === "string" ? record.timestamp : null;
    const message = record.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (record.type === "assistant" && Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object" || (block as Record<string, unknown>).type !== "tool_use") continue;
        const b = block as Record<string, unknown>;
        const id = typeof b.id === "string" ? b.id : null;
        const input = (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>;
        const command = typeof input.command === "string" ? input.command : "";
        if (!id || !command || !SEND_COMMAND_RE.test(command)) continue;
        const targetMatch = /--target[=\s]+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
        sendAttempts.set(id, {
          message: parseSentMessage(command, ts),
          target: targetMatch ? targetMatch[1] ?? targetMatch[2] ?? targetMatch[3] ?? null : null,
        });
      }
    } else if (record.type === "user") {
      const handleResult = (id: string | null, resultText: string) => {
        if (id !== null && sendAttempts.has(id)) {
          const attempt = sendAttempts.get(id)!;
          const delivered = /Message sent/.test(resultText);
          if (attempt.message) {
            if (delivered) found.push(attempt.message);
            else if (attempt.target) pendingDraftByTarget.set(attempt.target, attempt.message);
          } else if (delivered && attempt.target) {
            // Bodyless resend (`--send-draft`): the delivered content is the
            // guard-blocked attempt pending for the same target.
            const pending = pendingDraftByTarget.get(attempt.target);
            if (pending) {
              found.push(pending);
              pendingDraftByTarget.delete(attempt.target);
            }
          }
          return;
        }
        if (resultText.includes("[target=")) found.push(...parseMessageChunks(resultText));
      };
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type === "tool_result") {
            const value = b.content;
            const resultText = typeof value === "string"
              ? value
              : Array.isArray(value)
                ? value.map((x) => (x && typeof x === "object" ? String((x as Record<string, unknown>).text ?? "") : "")).join("\n")
                : "";
            handleResult(typeof b.tool_use_id === "string" ? b.tool_use_id : null, resultText);
          } else if (b.type === "text" && typeof b.text === "string" && b.text.includes("[target=")) {
            found.push(...parseMessageChunks(b.text));
          }
        }
      } else if (typeof content === "string" && content.includes("[target=")) {
        found.push(...parseMessageChunks(content));
      }
    }
  }

  // Dedupe by message id (falling back to target+body), newest occurrence
  // deciding order, longest body deciding content.
  const byKey = new Map<string, { message: PanelMessage; order: number }>();
  found.forEach((message, index) => {
    const key = message.msgId ?? `${message.self}|${message.raw.slice(0, 100)}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.order = index;
      if (message.raw.length > existing.message.raw.length) existing.message = message;
    } else {
      byKey.set(key, { message, order: index });
    }
  });
  // True chronological order by the messages' own timestamps: transcript
  // encounter order lies when an old message is re-presented by a later
  // catch-up (it would sort to the bottom and read as current — the top
  // misdirection in the gold bench).
  const sortValue = (entry: { message: PanelMessage; order: number }): number => {
    const ts = entry.message.ts;
    if (ts) {
      const parsed = Date.parse(ts.includes("T") ? ts : ts.replace(" ", "T"));
      if (Number.isFinite(parsed)) return parsed;
    }
    return entry.order; // ts-less entries keep encounter order at the epoch floor
  };
  return [...byKey.values()]
    .sort((a, b) => sortValue(a) - sortValue(b) || a.order - b.order)
    .slice(-Math.max(0, max))
    .map((entry) => entry.message);
}

interface HotObject {
  name: string;
  key: string;
  last: number;
  touches: number;
  content: string | null;
  isFile: boolean;
  lastTs: string | null;
}

function pathsIn(text: string): string[] {
  const out = new Set<string>();
  const re = /[\w.~@/-]*[/][\w.@/-]+|\b[\w-]+\.(?:ts|js|py|md|json|yml|yaml|toml|jsonl|sh|tsx|html|css|txt|lock)\b/g;
  for (const match of text.matchAll(re)) {
    const p = match[0].replace(/^[.,;:'"()[\]]+|[.,;:'"()[\]]+$/g, "");
    if (p.length < 4 || p.startsWith("http")) continue;
    out.add(p);
  }
  return [...out];
}

/** Objects the agent worked on: files (by path) and distinct shell commands
 * (deduplicated by shape, latest output wins). */
export function hotObjects(actions: readonly TranscriptAction[]): HotObject[] {
  const index = new Map<string, HotObject>();
  // Files only (2026-09-12): command-shape objects ("$ raft task list" dumps,
  // held-draft outputs with embedded "Next action:" affordances) were the gold
  // bench's most-cited misdirection — stale operational residue that reads as
  // an agenda. Durable working state lives in files.
  for (const action of actions) {
    const command = typeof action.input.command === "string" ? action.input.command : "";
    const filePaths = new Set<string>();
    if (typeof action.input.file_path === "string") filePaths.add(action.input.file_path);
    for (const p of pathsIn(command)) filePaths.add(p);
    let content: string | null = null;
    if (action.tool === "Read") content = action.result;
    else if (action.tool === "Write" && typeof action.input.content === "string") content = action.input.content;
    else if (action.tool === "Edit" && typeof action.input.new_string === "string") content = action.input.new_string;
    for (const filePath of filePaths) {
      // Prose containing a slash ("tool/infra", "/marketplace") and device
      // paths match the path regex; a real working file has an extension on
      // its final segment. Directories add nothing over their files.
      const lastSegment = filePath.split("/").filter(Boolean).at(-1) ?? "";
      if (filePath.startsWith("/dev/") || filePath.endsWith("/") || !lastSegment.includes(".")) continue;
      const segments = filePath.split("/").filter(Boolean);
      const key = segments.length > 1 ? segments.slice(-2).join("/") : segments[0] ?? filePath;
      const entry = index.get(key) ?? { name: filePath, key, last: 0, touches: 0, content: null, isFile: true, lastTs: null };
      entry.last = action.i;
      entry.touches += 1;
      entry.lastTs = action.ts;
      if (content) entry.content = content;
      if (filePath.startsWith("/")) entry.name = filePath;
      index.set(key, entry);
    }
  }
  return [...index.values()];
}

async function rereadFile(filePath: string): Promise<string | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > REREAD_FILE_MAX_BYTES) return null;
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/** A hot object with its live re-read resolved (I/O done by the collector so
 * the registered panel formatter below stays pure). */
export interface ResolvedPanelObject {
  name: string;
  touches: number;
  lastTs: string | null;
  isFile: boolean;
  /** Transcript-sourced content (last Read result / written content). */
  transcriptBody: string | null;
  /** Live file content re-read at construction time, when possible. */
  rereadBody: string | null;
  /** Touched near the session's end. Out-of-play objects render as bare
   * pointers: name and last-observed time, no body. */
  inPlay: boolean;
}

export interface ConstructedPanelInput {
  messages: PanelMessage[];
  objects: ResolvedPanelObject[];
  tail: TranscriptAction[];
  totalActions: number;
  budgetTokens: number;
}

/** A message renders IN FULL: a truncated message reads as complete and
 * invites confident mistakes, so the budget drops whole old messages instead.
 * Only a single pathological giant is cut, with an explicit marker. */
function messageLine(message: PanelMessage): string {
  if (tokens(message.raw) <= MESSAGE_MAX_TOKENS) return message.raw;
  return `${message.raw.slice(0, MESSAGE_MAX_TOKENS * 4)}\n[… truncated — read the channel for the rest]`;
}

export const formatConstructedPanel = axSurface(
  "Constructed wake panel: XML-delimited sections — recent messages (verbatim CLI rendering), objects in play with live re-read freshness, and the recent-actions tail — rendered into a token budget",
  (input: ConstructedPanelInput): string => {
    // XML section boundaries throughout: message bodies and file contents are
    // markdown themselves, so markdown headings cannot delimit them. No
    // open-loops section (removed 2026-09-12): across 1,301 real full-context
    // continuations at idle boundaries, only 20% touched a prior unresolved
    // failure in their next burst — the `!` marks in <recent-actions> keep
    // that information discoverable without front-loading it as an agenda.
    const sections: string[] = [];
    if (input.messages.length > 0) {
      const lines = input.messages.map(messageLine);
      // Whole oldest messages drop first when the section overruns its cap;
      // the ones that stay are complete.
      while (lines.length > 1 && tokens(lines.join("\n\n")) > MESSAGES_SECTION_CAP_TOKENS) lines.shift();
      // The note is a fact, not advice: "re-read channels for authority" was
      // cited by two of three R1 judges as inviting a history-reconstruction
      // ritual before the trigger. The panel states what it holds and stops.
      sections.push(
        '<recent-messages order="newest last" note="recent tail only; older messages not shown">',
        lines.join("\n\n"),
        "</recent-messages>",
        "",
      );
    }

    const tailSection = [
      `<recent-actions span="${input.tail.length} of ${input.totalActions}" order="oldest first">`,
      ...input.tail.map(actionLine),
      "</recent-actions>",
    ];

    let left = input.budgetTokens - tokens(sections.join("\n")) - tokens(tailSection.join("\n")) - 60;
    const objectLines: string[] = ["<objects-in-play>"];
    for (const object of input.objects.slice(0, MAX_PANEL_OBJECTS)) {
      if (left <= 80) break;
      if (!object.inPlay) {
        // Bare pointer, no body, no advice: hours-old note files carry
        // imperative residue ("Next step: …") that reads as a live agenda.
        const pointer = `<object name="${object.name}" touched="${object.touches}x"`
          + `${object.lastTs ? ` last-observed="${object.lastTs}"` : ""}/>`;
        objectLines.push(pointer);
        left -= tokens(pointer);
        continue;
      }
      let body = SENSITIVE_PATH_RE.test(object.name) ? null : object.transcriptBody;
      let freshness = object.lastTs ? `last observed ${object.lastTs}` : "last observed earlier";
      if (object.rereadBody !== null) {
        body = object.rereadBody;
        freshness = "current — re-read just now";
      } else if (object.isFile && body) {
        freshness += "; could not re-read, may be stale";
      }
      if (!body) {
        // An in-play object with no recoverable content renders in the same
        // pointer form as an out-of-play one; an empty tag pair says nothing.
        const pointer = `<object name="${object.name}" touched="${object.touches}x"`
          + `${object.lastTs ? ` last-observed="${object.lastTs}"` : ""}/>`;
        objectLines.push(pointer);
        left -= tokens(pointer);
        continue;
      }
      const title = `<object name="${object.name}" touched="${object.touches}x" freshness="${freshness}">`;
      left -= tokens(title) + 4;
      objectLines.push(title);
      if (body) {
        const cap = object.rereadBody !== null ? OBJECT_CONTENT_CAP_TOKENS : STALE_OBJECT_BODY_CAP_TOKENS;
        const share = Math.min(cap, left);
        let clipped = body.slice(0, share * 4);
        if (clipped.length < body.length) {
          // Cut on a line boundary and say so: a mid-sentence cut reads as
          // complete and manufactures an information gap (R1 bench, b5).
          const lastBreak = clipped.lastIndexOf("\n");
          if (lastBreak > clipped.length / 2) clipped = clipped.slice(0, lastBreak);
          clipped += "\n[… truncated]";
        }
        objectLines.push(clipped);
        left -= tokens(clipped);
      }
      objectLines.push("</object>");
    }
    objectLines.push("</objects-in-play>");

    return [...sections, ...objectLines, "", ...tailSection].join("\n");
  },
  {
    examples: [{
      title: "one received and one sent message, one re-read file, two tail actions",
      args: [{
        messages: [
          { raw: "[target=#proj-x:abcd1234 msg=abc12345 time=2026-08-30 00:00:02Z] @alice: ping, did the deploy finish?", msgId: "abc12345", ts: "2026-08-30 00:00:02Z", self: false },
          { raw: "[target=#proj-x:abcd1234 time=2026-08-30 00:00:03Z] you sent: yes, all green", msgId: null, ts: "2026-08-30T00:00:03.000Z", self: true },
        ],
        objects: [{ name: "/workspace/MEMORY.md", touches: 2, lastTs: "2026-08-30T00:00:00.000Z", isFile: true, transcriptBody: "# Memory", rereadBody: "# Memory\n- updated", inPlay: true }],
        tail: [
          { i: 3, tool: "Bash", input: { command: "pnpm test" }, result: "exit code 1", ok: false, mutating: false, ts: "2026-08-30T00:00:00.000Z" },
          { i: 4, tool: "Read", input: { file_path: "/workspace/MEMORY.md" }, result: "# Memory", ok: true, mutating: false, ts: "2026-08-30T00:00:01.000Z" },
        ],
        totalActions: 5,
        budgetTokens: 8_000,
      }],
    }],
  },
);

/**
 * Build the constructed panel from the retired session's transcript: parse
 * the action log, resolve live re-reads, and render via the registered
 * formatter. Sections, in the order the budget protects them: recent
 * messages, objects in play (live re-read where possible), recent actions.
 */
export async function buildConstructedPanel(args: {
  transcriptPath: string;
  workspacePath?: string;
  budgetTokens?: number;
  /** Max messages in the recent-messages section; 0 disables the section. */
  recentMessagesMax?: number;
}): Promise<AxSurfaceText | null> {
  const budget = args.budgetTokens ?? DEFAULT_PANEL_BUDGET_TOKENS;
  const actions = await parseTranscriptActions(args.transcriptPath);
  if (actions.length < 5) return null;
  const recentMessagesMax = args.recentMessagesMax ?? RECENT_MESSAGES_DEFAULT;
  const messages = recentMessagesMax > 0
    ? await collectRecentMessages(args.transcriptPath, recentMessagesMax)
    : [];

  const maxIndex = Math.max(1, ...actions.map((a) => a.i));
  const lastTsMs = [...actions].reverse()
    .map((a) => (a.ts ? Date.parse(a.ts) : Number.NaN))
    .find((t) => Number.isFinite(t));
  const isInPlay = (object: HotObject): boolean => {
    if (lastTsMs !== undefined && object.lastTs) {
      const objectMs = Date.parse(object.lastTs);
      if (Number.isFinite(objectMs)) return lastTsMs - objectMs <= OBJECT_IN_PLAY_WINDOW_MS;
    }
    return object.last >= maxIndex - OBJECT_IN_PLAY_ACTIONS;
  };
  const ranked = hotObjects(actions)
    .sort((a, b) => b.touches * (0.3 + b.last / maxIndex) - a.touches * (0.3 + a.last / maxIndex))
    .sort((a, b) => Number(isInPlay(b)) - Number(isInPlay(a)));
  const objects: ResolvedPanelObject[] = [];
  for (const object of ranked) {
    const inPlay = isInPlay(object);
    let rereadBody: string | null = null;
    // Relative names resolve against the workspace (agents driving everything
    // through Bash touch files as `notes/x.md`, never absolute). MEMORY.md is
    // owned by the memory-index section — a second copy here is pure
    // duplication. Sensitive files never contribute content.
    const rereadable = inPlay && object.isFile
      && (path.isAbsolute(object.name) || args.workspacePath !== undefined)
      && !/(^|\/)MEMORY\.md$/.test(object.name)
      && !SENSITIVE_PATH_RE.test(object.name);
    if (rereadable) {
      rereadBody = await rereadFile(
        path.isAbsolute(object.name) ? object.name : path.join(args.workspacePath ?? "", object.name),
      );
    }
    objects.push({
      name: object.name,
      touches: object.touches,
      lastTs: object.lastTs,
      isFile: object.isFile,
      transcriptBody: object.content,
      rereadBody,
      inPlay,
    });
  }

  return formatConstructedPanel({
    messages,
    objects,
    tail: actions.slice(-RECENT_ACTIONS),
    totalActions: actions.length,
    budgetTokens: budget,
  });
}
