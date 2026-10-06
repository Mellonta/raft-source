import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import { isJointChannelReadOnly, jointChannelGraceEndsAt, jointInviteAcceptErrorMessage } from "../src/utils/jointChannelLimit";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

const deadline = "2027-01-04T00:00:00.000Z";
const deadlineMs = Date.parse(deadline);

test("contract v0.3 §18.8: a joint is read-only when locked, or once the local clock reaches the deadline", () => {
  const grace = { type: "joint", jointBillingLocked: false, jointOverLimitGraceEndsAt: deadline };
  assert.equal(isJointChannelReadOnly(grace, deadlineMs - 1), false);
  assert.equal(jointChannelGraceEndsAt(grace, deadlineMs - 1), deadline);
  // Stale metadata fetched during grace still says unlocked after the deadline.
  assert.equal(isJointChannelReadOnly(grace, deadlineMs), true);
  assert.equal(jointChannelGraceEndsAt(grace, deadlineMs), null);
  assert.equal(isJointChannelReadOnly({ type: "joint", jointBillingLocked: true, jointOverLimitGraceEndsAt: null }, 0), true);
});

test("within the limit, or not a joint channel, is never read-only", () => {
  assert.equal(isJointChannelReadOnly({ type: "joint", jointBillingLocked: false, jointOverLimitGraceEndsAt: null }), false);
  assert.equal(isJointChannelReadOnly({ type: "joint", jointOverLimitGraceEndsAt: "" }), false);
  assert.equal(isJointChannelReadOnly({ type: "channel", jointBillingLocked: true }), false);
  assert.equal(jointChannelGraceEndsAt({ type: "joint", jointOverLimitGraceEndsAt: null }), null);
});

test("a failed joint invite accept explains the limit instead of failing silently", () => {
  const en = createIntl({ locale: "en", messages: enMessages as Record<string, string> });
  const zh = createIntl({ locale: "zh-cn", messages: zhMessages as Record<string, string> });
  const failure = (data: Record<string, unknown>) => ({ response: { data } });

  const freeLimit = failure({ error: "server text", code: "joint_free_server_limit" });
  assert.equal(
    jointInviteAcceptErrorMessage(freeLimit, en.formatMessage),
    "This Joint Channel already has 2 free servers. Upgrade either side to Pro, or have a free server leave, to continue (30 servers max).",
  );
  assert.equal(
    jointInviteAcceptErrorMessage(freeLimit, zh.formatMessage),
    "这个联合频道已满 2 个免费服务器。把任一方升级到 Pro，或有免费服务器退出后，可以继续加入（总服务器上限 30 个）",
  );
  assert.match(jointInviteAcceptErrorMessage(failure({ code: "joint_server_limit" }), en.formatMessage), /limited to 30 servers/);
  // Other failures keep the server's reason (expired, already taken, not an admin).
  assert.equal(jointInviteAcceptErrorMessage(failure({ error: "Joint channel invite has expired" }), en.formatMessage), "Joint channel invite has expired");
  assert.equal(jointInviteAcceptErrorMessage(new Error("network"), en.formatMessage), "Couldn't accept the Joint Channel invite.");
});
