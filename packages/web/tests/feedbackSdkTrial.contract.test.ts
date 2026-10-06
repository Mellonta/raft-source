import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const webRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(webRoot, "../..");
const feedbackSdkVersion = "0.4.1";

function read(root: string, path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

test("feedback visual cases render the Hands SDK workspace", () => {
  const source = read(webRoot, "visual-testing/FeedbackSdkTrial.tsx");
  assert.match(source, /FeedbackWorkspace/);
  assert.match(
    source,
    /import "@botiverse\/hands-feedback-react\/styles\.css";/,
  );
  assert.match(source, /initialTicketId: TRIAL_TICKET_ID/);
  assert.match(source, /<FeedbackProvider[\s\S]*?<FeedbackWorkspace/);
  assert.doesNotMatch(source, /function (?:InboxTrial|DetailTrial|CommentCard)/);
  assert.doesNotMatch(source, /from "raft-ui(?:\/wip)?"/);

  const cases = read(webRoot, "visual-testing/VisualTestingCases.tsx");
  for (const id of [
    "screens.feedback-sdk.inbox",
    "screens.feedback-sdk.inbox.narrow",
    "screens.feedback-sdk.detail",
    "screens.feedback-sdk.detail.narrow",
  ]) {
    assert.match(cases, new RegExp(id.replaceAll(".", "\\.")));
  }
});

test("settings feedback shell owns the page title without restyling the SDK", () => {
  const panel = read(webRoot, "src/components/settings/AboutFeedbackDialog.tsx");
  const lazyPanel = read(webRoot, "src/components/settings/LazyAboutFeedbackDialog.tsx");

  assert.match(panel, /<PanelHeader[\s\S]*settings\.about\.feedbackTitle/);
  // The SDK hides only its inbox title and keeps its actions right-aligned;
  // ticket and composer headers keep their own titles and back buttons.
  assert.match(panel, /<FeedbackWorkspace[\s\S]*?hideHeaderTitle[\s\S]*?\/>/);
  // Colors and layout come from the SDK stylesheet alone.
  assert.doesNotMatch(lazyPanel, /feedbackTheme\.css/);
  assert.ok(!existsSync(resolve(webRoot, "src/components/settings/feedbackTheme.css")));
});

test("feedback SDK is the published npm release, not a Hands git source pin", () => {
  const packageJson = JSON.parse(read(webRoot, "package.json")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(
    packageJson.dependencies?.["@botiverse/hands-feedback-react"],
    feedbackSdkVersion,
  );

  const lockfile = read(repoRoot, "pnpm-lock.yaml");
  assert.ok(lockfile.includes(`'@botiverse/hands-feedback-react@${feedbackSdkVersion}'`));
  assert.ok(!lockfile.includes("#path:/packages/feedback-react"));

  for (const path of [
    "src/components/settings/AboutFeedbackDialog.tsx",
    "src/components/settings/LazyAboutFeedbackDialog.tsx",
    "src/feedback/handsFeedbackTransport.ts",
    "visual-testing/FeedbackSdkTrial.tsx",
  ]) {
    assert.doesNotMatch(read(webRoot, path), /@botiverse\/hands-feedback-react\/source/, path);
  }
});

test("feedback conversation uses the shared Raft message composition", () => {
  const styles = read(
    webRoot,
    "node_modules/@botiverse/hands-feedback-react/src/styles.css",
  );
  const components = read(
    webRoot,
    "node_modules/@botiverse/hands-feedback-react/src/components.tsx",
  );
  assert.match(
    styles,
    /\.hands-feedback-conversation-root\s*\{[^}]*max-width:\s*var\(--hf-content-width\)/,
  );
  assert.match(styles, /\.hands-feedback-conversation\s*\{[^}]*padding:\s*2px 0 12px/);
  assert.match(components, /<MessageItem data-author=\{authorType\}>/);
  assert.match(components, /<MessageItemAvatarSlot>[\s\S]*?<MessageItemContent>/);
  assert.match(components, /<MessageItemHeader>[\s\S]*?<MessageItemBody>/);
});

test("feedback list follows Raft task status and card interaction colors", () => {
  const styles = read(
    webRoot,
    "node_modules/@botiverse/hands-feedback-react/src/styles.css",
  );
  const components = read(
    webRoot,
    "node_modules/@botiverse/hands-feedback-react/src/components.tsx",
  );
  const locale = read(
    webRoot,
    "node_modules/@botiverse/hands-feedback-react/src/locale.ts",
  );
  for (const [status, variant] of [
    ["open", "warning"],
    ["in_progress", "information"],
    ["resolved", "success"],
    ["closed", "muted"],
  ] as const) {
    assert.match(
      components,
      new RegExp(`${status}: \\{[\\s\\S]*?variant: "${variant}" as const`),
    );
  }
  // Status colors come from the raft-ui Badge variants in every theme; the
  // SDK no longer pins brutal colors inline.
  assert.doesNotMatch(components, /backgroundColor: "var\(--color-brutal-/);
  assert.match(
    styles,
    /\.hands-feedback-ticket-open\s*\{[^}]*position:\s*absolute[^}]*width:\s*100%/,
  );
  assert.match(
    styles,
    /\.hands-feedback-ticket-open:focus-visible\s*\{[^}]*var\(--hf-border-strong\)/,
  );
  assert.match(
    styles,
    /\.hands-feedback-ticket-content\s*\{[^}]*pointer-events:\s*auto[^}]*z-index:\s*1/,
  );
  assert.match(
    styles,
    /\.hands-feedback-close-split\s*\{[^}]*pointer-events:\s*auto/,
  );
  assert.match(
    styles,
    /\.hands-feedback-close-split\s*\{[^}]*height:\s*20px/,
  );
  assert.match(
    styles,
    /\.hands-feedback-close-caret\s*\{[^}]*min-width:\s*20px/,
  );
  assert.match(
    styles,
    /\.hands-feedback-close-split\[data-menu-open\],[\s\S]*\.hands-feedback-close-split:has\(\.hands-feedback-close-main:active\),[\s\S]*\.hands-feedback-close-split:has\(\.hands-feedback-close-caret:active\)\s*\{[^}]*box-shadow:\s*4px 4px 0 var\(--line-strong\)[^}]*translate:\s*0 -1px/,
  );
  assert.match(
    styles,
    /\.hands-feedback-close-caret\[data-popup-open\]\s*\{[^}]*box-shadow:\s*none !important[^}]*translate:\s*0 !important/,
  );
  assert.match(
    styles,
    /\.hands-feedback-close-main\s*\{[^}]*padding-left:\s*8px/,
  );
  assert.match(
    styles,
    /\.hands-feedback-close-main::before\s*\{[^}]*display:\s*none/,
  );
  assert.match(
    styles,
    /\.hands-feedback-close-menu-item \[data-slot="dropdown-menu-item-label"\],[\s\S]*\.hands-feedback-close-menu-item \[data-slot="dropdown-menu-item-label"\] span\s*\{[^}]*overflow:\s*visible[^}]*text-overflow:\s*clip[^}]*white-space:\s*normal/,
  );
  assert.match(
    styles,
    /\.hands-feedback-close-menu\s*\{[^}]*max-width:\s*calc\(100vw - 24px\)[^}]*min-width:\s*max-content[^}]*width:\s*max-content/,
  );
  assert.match(styles, /\.hands-feedback-close-menu-item\s*\{[^}]*width:\s*100%/);
  assert.match(
    styles,
    /\.hands-feedback-inbox-content\s*\{[^}]*padding:\s*18px 18px calc\(18px \+ env\(safe-area-inset-bottom, 0px\)\)/,
  );
  assert.match(
    styles,
    /\.hands-feedback-list-scroll\[data-feedback-empty-scroll="true"\]\s*\{[^}]*gap:\s*0[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)[^}]*padding:\s*6px 2px 0/,
  );
  assert.match(
    styles,
    /@media \(max-width: 640px\)[\s\S]*?\.hands-feedback-inbox-content\s*\{[^}]*padding:\s*18px 16px calc\(18px \+ env\(safe-area-inset-bottom, 0px\)\)/,
  );
  assert.doesNotMatch(
    styles,
    /@media \(max-width:\s*640px\)\s*\{[\s\S]*?\.hands-feedback-close-main,\s*\.hands-feedback-close-caret\s*\{/,
  );
  assert.match(
    components,
    /className="hands-feedback-reference-chip hands-feedback-close-main"/,
  );
  assert.match(
    components,
    /status === "closed" && closureReason === "completed"[\s\S]*?\? "resolved"[\s\S]*?: status/,
  );
  assert.match(components, /data-feedback-status=\{status\}/);
  assert.match(components, /data-feedback-display-status=\{displayStatus\}/);
  assert.match(
    components,
    /<FeedbackStatusChip[\s\S]*?status=\{ticket\.status\}[\s\S]*?closureReason=\{ticket\.closureReason\}/,
  );
  assert.match(components, />\{message\("closeTicket"\)\}<\/MessageReferenceLabel>/);
  assert.match(components, /reason === "completed"[\s\S]*?"closeTicketCompletedConfirm"[\s\S]*?"closeTicketNoLongerNeededConfirm"/);
  assert.match(components, /reason === "completed"[\s\S]*?"closeTicketCompletedDescription"[\s\S]*?"closeTicketNoLongerNeededDescription"/);
  assert.doesNotMatch(components, /hands-feedback-close-reason-summary/);
  assert.doesNotMatch(styles, /hands-feedback-close-reason-summary/);
  assert.match(locale, /closeTicketCompletedConfirm:\s*"问题已解决，关闭工单？"/);
  assert.match(locale, /closeTicketNoLongerNeededConfirm:\s*"不再需要处理，关闭工单？"/);
  assert.match(locale, /关闭后将无法继续回复。如果问题再次出现，可以重新提交反馈。/);
  assert.match(locale, /即使问题尚未解决，也会直接关闭工单。如果仍需帮助，可以重新提交反馈。/);
  assert.doesNotMatch(locale, /closeTicketConfirm:/);
  assert.doesNotMatch(locale, /closeTicketDescription:/);
  assert.match(components, /<TaskCard className="hands-feedback-ticket-card">/);
  assert.match(components, /ticket\.status !== "closed"/);
  assert.doesNotMatch(components, /reopenTicket/);
  assert.match(
    components,
    /value === "open" \? "active" : "ended"/,
  );
  assert.match(locale, /active:\s*"Active"/);
  assert.match(locale, /active:\s*"活跃"/);
  assert.match(locale, /ended:\s*"Ended"/);
  assert.match(locale, /ended:\s*"已结束"/);
});
