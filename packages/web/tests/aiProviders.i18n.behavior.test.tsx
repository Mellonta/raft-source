import assert from "node:assert/strict";
import { createIntl } from "react-intl";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

test("catalog pins AI provider MessageIds", () => {
  assert.equal(en["settings.providers.openaiCompatible"], "OpenAI-compatible");
  assert.equal(en["settings.providers.anthropicCompatible"], "Anthropic-compatible");
  assert.equal(zh["settings.providers.openaiCompatible"], "OpenAI-compatible");
  assert.equal(zh["settings.providers.anthropicCompatible"], "Anthropic-compatible");
});

test("AI provider labels format under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.equal(zhIntl.formatMessage({ id: "settings.providers.openaiCompatible" }), "OpenAI-compatible");
  assert.equal(zhIntl.formatMessage({ id: "settings.providers.anthropicCompatible" }), "Anthropic-compatible");
});

test("assigned-Agent disclosure copy is localized in both locales", () => {
  const enIntl = createIntl({ locale: "en", defaultLocale: "en", messages: mergedMessages("en") });
  const zhIntl = createIntl({ locale: "zh-cn", defaultLocale: "en", messages: mergedMessages("zh-cn") });

  assert.equal(en["settings.providers.assignedAgents"], "Assigned Agents");
  assert.equal(zh["settings.providers.assignedAgents"], "已关联的 Agent");
  assert.equal(en["settings.providers.assignedAgentDeleted"], "Deleted");
  assert.equal(zh["settings.providers.assignedAgentDeleted"], "已删除");
  assert.equal(en["settings.providers.assignedAgentDetach"], "Detach");
  assert.equal(zh["settings.providers.assignedAgentDetach"], "解除关联");
  assert.equal(en["settings.providers.assignedAgentsRetry"], "Retry");
  assert.equal(zh["settings.providers.assignedAgentsRetry"], "重试");

  assert.equal(enIntl.formatMessage({ id: "settings.providers.assignedAgentHandle" }, { name: "alice" }), "@alice");
  assert.equal(zhIntl.formatMessage({ id: "settings.providers.assignedAgentHandle" }, { name: "alice" }), "@alice");
  assert.equal(enIntl.formatMessage({ id: "settings.providers.assignedAgentOpen" }, { name: "Alice" }), "Open Alice");
  assert.equal(zhIntl.formatMessage({ id: "settings.providers.assignedAgentOpen" }, { name: "Alice" }), "打开 Alice");
  assert.equal(enIntl.formatMessage({ id: "settings.providers.agentStatus.active" }), "Online");
  assert.equal(zhIntl.formatMessage({ id: "settings.providers.agentStatus.active" }), "在线");
  assert.equal(zhIntl.formatMessage({ id: "settings.providers.agentStatus.stopped" }), "已停止");
  assert.ok(zhIntl.formatMessage({ id: "settings.providers.detachConfirm" }, { name: "retired" }).includes("retired"));
  assert.ok(enIntl.formatMessage({ id: "settings.providers.assignedAgentsUnblockHint" }).length > 0);
});
