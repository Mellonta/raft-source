import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const onboardingSource = readFileSync(
  new URL("./onboardingService.ts", import.meta.url),
  "utf8",
);
const appOwnedReminderServiceSource = readFileSync(
  new URL("../apps/reminder/service.ts", import.meta.url),
  "utf8",
);

const RETIRED_SERVER_REMINDER_CONSUMERS = [
  /platformBridge/,
  /prepareTimerCancellation/,
  /hardDeleteAfterTimer/,
  /cancelAfterTimer/,
  /\brearm\(/,
  /deliverFireWake/,
  /deliverBuiltInDueEvent/,
  /prepareSystemMessageForOrderedDelivery/,
  /broadcastSystemMessage\([^)]*(?:reminder|Reminder)/s,
];

test("Onboarding publish committed lifecycle revisions to the Computer", () => {
  assert.match(onboardingSource, /import \{ createAppReminder \} from "\.\.\/apps\/reminder\/crud";/);
  assert.match(onboardingSource, /await input\.deps\.createSchedule\(/);
  assert.match(onboardingSource, /pushReminderUpsert\(row\.ownerAgentId, row\)/);

});

test("retired Server timer, derived-DM, message, and direct-wake consumers stay absent", () => {
  const combined = `${onboardingSource}\n${appOwnedReminderServiceSource}`;
  for (const consumer of RETIRED_SERVER_REMINDER_CONSUMERS) {
    assert.doesNotMatch(combined, consumer);
  }
  assert.doesNotMatch(appOwnedReminderServiceSource, /getDueReminders/);
});
