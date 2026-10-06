import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import { mergedMessages } from "../src/i18n/messages/index";
import { formatActivityTextDescriptor, getActivityTextDescriptor } from "../src/utils/activity";
import { useAgentStore } from "../src/store/agentStore";

// task #1119 — the web must show the server's "automatic wake paused" state
// with dedicated copy and keep the typed carrier until the next plain activity.

const carrier = {
  episode: 1,
  earlyExitCount: 3,
  threshold: 3,
  windowMs: 60_000,
  blocked: true,
  blockedAtMs: 30_000,
  firstExitAtMs: 10_000,
  lastExitAtMs: 30_000,
  lastExitKind: "machine_disconnected",
  lastSignal: null,
  lastLaunchId: "launch-3",
} as const;

test("wake_crash_loop_blocked has dedicated copy in both catalogs and is not rendered as plain Offline", () => {
  const descriptor = getActivityTextDescriptor("offline", "", "wake_crash_loop_blocked" as never);
  assert.ok("id" in descriptor.primary);
  assert.equal((descriptor.primary as { id: string }).id, "activity.status.wakeCrashLoopBlocked");
  for (const locale of ["en", "zh-cn"] as const) {
    const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
    const text = formatActivityTextDescriptor(intl.formatMessage, descriptor);
    assert.ok(text.length > 0 && !text.includes("activity.status."), `${locale} copy must resolve`);
    assert.notEqual(text, intl.formatMessage({ id: "activity.status.offline" }));
  }
});

test("the store keeps the wakeCrashLoop carrier with the blocked state and drops it on the next plain activity", () => {
  useAgentStore.getState().updateActivity(
    "agent-9",
    "offline",
    "Automatic wake paused after 3 early exits",
    20,
    900,
    { launchId: "launch-3", clientSeq: 1 },
    "offline",
    "wake_crash_loop_blocked",
    { clientEventId: "evt-9" },
    false,
    false,
    undefined,
    carrier,
  );
  const state = useAgentStore.getState().agentActivities["agent-9"];
  assert.equal(state?.detailKind, "wake_crash_loop_blocked");
  assert.deepEqual(state?.wakeCrashLoop, carrier);
  useAgentStore.getState().updateActivity("agent-9", "working", "Starting", 21, 1000, { launchId: "launch-4", clientSeq: 2 }, "working", "starting");
  assert.equal(useAgentStore.getState().agentActivities["agent-9"]?.wakeCrashLoop, undefined);
});
