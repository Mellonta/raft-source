import { AsyncLocalStorage } from "node:async_hooks";
import type { ActiveSpan, TraceContext } from "@botiverse/raft-shared";

// Node only active span store for daemon side callers. Spans started while a
// span is active default their parent to it, so a bounded flow (one reminder
// fire, one inbox notice) ends up as one trace instead of many roots.
//
// Only wrap bounded flows with runWithActiveSpan. Never wrap timers, loops, or
// long lived connections: every async resource created inside the scope keeps
// pointing at the span long after it ended.
const activeSpanStore = new AsyncLocalStorage<ActiveSpan>();

export function runWithActiveSpan<T>(span: ActiveSpan, work: () => T): T {
  return activeSpanStore.run(span, work);
}

// Leave the active span scope for work that outlives the current flow, for
// example spawning an agent process whose later events must not inherit the
// span that happened to trigger the spawn.
export function runWithoutActiveSpan<T>(work: () => T): T {
  return activeSpanStore.exit(work);
}

export function getActiveSpan(): ActiveSpan | null {
  return activeSpanStore.getStore() ?? null;
}

export function getActiveTraceContext(): TraceContext | null {
  return getActiveSpan()?.context ?? null;
}
