import {
  buildStateTransitionTraceAttrs,
} from "@botiverse/raft-shared";
import type {
  StateTransitionTraceInput,
} from "@botiverse/raft-shared";
import { emitWebEvent } from "./webAuthTrace";

type StateTransitionEmitter = typeof emitWebEvent;

let emitter: StateTransitionEmitter = emitWebEvent;

export function __setStateTransitionEmitterForTest(next: StateTransitionEmitter | null): void {
  emitter = next ?? emitWebEvent;
}

export function emitStateTransitionTrace(input: StateTransitionTraceInput): void {
  try {
    emitter("slock.state.transition", buildStateTransitionTraceAttrs(input) as unknown as Record<string, unknown>);
  } catch {
    // Trace emission must never affect state transitions.
  }
}
