import type { SystemMessageInboxFactPolicy } from "./messageService";

// Compile-time guard for the producer→causalActor coupling on system messages.
//
// This is NOT a runtime test: the `@ts-expect-error` directives are the check,
// enforced by `pnpm --filter @botiverse/raft-server typecheck`. The
// discriminated union `SystemMessageInboxFactPolicy` requires `causalActor` for
// `born-read` producers and forbids it (`?: never`) for `notify-exclude` / `skip`
// / `real-sender` producers. If the union collapses back to two states
// (causalActor optional everywhere), the now-unused directives fail typecheck —
// in BOTH directions.
function _typeLevelGuard(): void {
  // Required direction: a born-read producer that omits causalActor must not
  // type-check.
  // @ts-expect-error — born-read producer requires causalActor
  const missingCausalActor: SystemMessageInboxFactPolicy = { mode: "record", producer: "channel.rename", reason: "r" };

  // Forbidden direction: a notify-exclude producer that passes causalActor must
  // not type-check.
  // @ts-expect-error — notify-exclude producer forbids causalActor
  const forbiddenCausalActor: SystemMessageInboxFactPolicy = { mode: "record", producer: "onboarding.owner_instruction", reason: "r", causalActor: { type: "user", id: "u" } };

  // Forbidden direction: a skip producer that passes causalActor must not
  // type-check.
  // @ts-expect-error — skip producer forbids causalActor
  const forbiddenCausalActorOnSkip: SystemMessageInboxFactPolicy = { mode: "skip", producer: "channel.self_unfollow_thread", reason: "r", causalActor: { type: "agent", id: "a" } };

  // Allowed controls (must type-check).
  const _allowedBornRead: SystemMessageInboxFactPolicy = { mode: "record", producer: "channel.rename", reason: "r", causalActor: { type: "agent", id: "a" } };
  const _allowedNotifyExclude: SystemMessageInboxFactPolicy = { mode: "record", producer: "onboarding.owner_instruction", reason: "r" };

  void missingCausalActor;
  void forbiddenCausalActor;
  void forbiddenCausalActorOnSkip;
  void _allowedBornRead;
  void _allowedNotifyExclude;
}
void _typeLevelGuard;
