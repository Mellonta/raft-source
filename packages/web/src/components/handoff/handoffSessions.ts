import { isElectronDesktopShell } from "../../utils/desktopShell";

// Desktop-only Handoff (#kabi-desktop task #13 → task #104): recent LOCAL
// Claude Code / Codex sessions read through the electron bridge, migrated into a
// normal Raft agent (existing createAgent API + a previewed briefing DM). This
// module holds the bridge access and the pure helpers; the UI lives in
// HandoffCreateFlow (rendered inside Create Agent as the "start from a local
// session" option since task #104 — the standalone rail page is gone).

export interface LocalSession {
  tool: "claude-code" | "codex";
  sessionId: string;
  cwd: string | null;
  model: string | null;
  title: string | null;
  lastActiveAt: number;
  sizeBytes: number;
  transcriptPath: string;
  activeRecently: boolean;
}

export interface SessionExcerpt {
  firstUserMessage: string | null;
  recentExcerpt: string;
}

export interface ContentSearchResult {
  // Full summaries (not ids): a hit may live outside the recency-bounded initial
  // listing, so the flow renders these directly rather than filtering the list.
  matches: LocalSession[];
  complete: boolean;
}

export interface HandoffBridge {
  listSessions(): Promise<LocalSession[]>;
  sessionExcerpt(input: { transcriptPath: string; tool: string }): Promise<SessionExcerpt>;
  /**
   * Full-content search over transcript bodies (id + directory + model + title +
   * body, all query terms must match somewhere). Optional: an older desktop
   * bridge without it degrades to metadata-only search.
   */
  searchContent?(query: string): Promise<ContentSearchResult>;
}

export function getHandoffBridge(): HandoffBridge | null {
  // Runtime narrowing, not just a type assertion: the preload owns this shape,
  // but a stale/foreign global must not crash the flow.
  const handoff = (globalThis as { raftDesktop?: { handoff?: unknown } }).raftDesktop?.handoff;
  if (!handoff || typeof handoff !== "object") return null;
  const candidate = handoff as Partial<HandoffBridge>;
  if (typeof candidate.listSessions !== "function" || typeof candidate.sessionExcerpt !== "function") return null;
  return candidate as HandoffBridge;
}

/**
 * Whether Create Agent may offer "start from a local session": the desktop
 * shell AND a bridge that can scan sessions. Web is always false.
 */
export function isHandoffAvailable(): boolean {
  return isElectronDesktopShell() && getHandoffBridge() !== null;
}

export type SearchState =
  | { status: "idle" }
  | { status: "pending"; query: string }
  | { status: "done"; query: string; summaries: LocalSession[]; complete: boolean };

export type SearchAction =
  | { type: "reset" }
  | { type: "pending"; query: string }
  | { type: "done"; query: string; summaries: LocalSession[]; complete: boolean };

export function searchReducer(_state: SearchState, action: SearchAction): SearchState {
  switch (action.type) {
    case "reset": return { status: "idle" };
    case "pending": return { status: "pending", query: action.query };
    case "done": return { status: "done", query: action.query, summaries: action.summaries, complete: action.complete };
  }
}

export interface LocalIdentity {
  hostname: string | null;
  /** Authoritative machine ids from the local computer host's attachments. */
  machineIds: string[];
}

export async function getLocalIdentity(): Promise<LocalIdentity> {
  const computer = (globalThis as {
    raftDesktop?: {
      computer?: {
        getLocalInfo?: () => Promise<{ hostname: string }>;
        getStatus?: () => Promise<unknown>;
      };
    };
  }).raftDesktop?.computer;
  const hostname = typeof computer?.getLocalInfo === "function"
    ? await computer.getLocalInfo().then((info) => info?.hostname ?? null).catch(() => null)
    : null;
  const status = typeof computer?.getStatus === "function"
    ? await computer.getStatus().catch(() => null)
    : null;
  const rows = (status as { servers?: Array<{ machineId?: string | null }> } | null)?.servers ?? [];
  const machineIds = rows
    .map((row) => row.machineId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return { hostname, machineIds };
}

export interface MachineLike {
  id: string;
  hostname: string | null;
  status: "online" | "offline";
}

/**
 * The machineStore row this app runs on, ONLINE only. Mirrors the desktop
 * frontend's `correlateSelfMachine` contract: authoritative attachment
 * machineIds win; hostname is only trusted when it matches exactly one row —
 * duplicate hostnames must not route a handoff to a different computer.
 */
export function pickLocalOnlineMachine<T extends MachineLike>(
  machines: readonly T[],
  identity: LocalIdentity,
): T | null {
  for (const id of identity.machineIds) {
    const match = machines.find((m) => m.id === id);
    if (match) return match.status === "online" ? match : null;
  }
  if (identity.hostname) {
    const matches = machines.filter((m) => m.hostname === identity.hostname);
    if (matches.length === 1 && matches[0].status === "online") return matches[0];
  }
  return null;
}

export const TOOL_LABEL: Record<LocalSession["tool"], string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

export function dirBasename(cwd: string | null): string | null {
  if (!cwd) return null;
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? null;
}
