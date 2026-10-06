import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

test("theme sweep keeps confirmation and drawer copy on semantic tokens", () => {
  const confirm = source("src/components/ConfirmDialog.tsx");
  const channel = source("src/components/channel/EditChannelDialog.tsx");
  const overflow = source("src/components/ui/OverflowSheet.tsx");
  const channelOverflow = source("src/components/channel/ChannelOverflowMenu.tsx");
  const markdown = source("src/components/markdown/MarkdownContent.tsx");

  assert.match(confirm, /data-slot="confirm-dialog-content"/);
  assert.match(confirm, /text-foreground-muted/);
  assert.doesNotMatch(confirm, /text-black\/75/);
  for (const drawer of [channel]) {
    assert.match(drawer, /className="[^"]*border-0 theme-brutal:[^"]*border-l-2/);
    assert.match(drawer, /text-foreground-strong/);
    assert.match(drawer, /text-foreground-muted/);
    assert.match(drawer, /bg-soft-signal[^\"]*text-black/);
  }
  assert.match(overflow, /className="[^"]*border-0[^\"]*theme-brutal:border-l-2/);
  assert.match(overflow, /text-foreground-strong/);
  assert.match(overflow, /text-foreground-muted/);
  assert.match(overflow, /bg-soft-signal[^\"]*text-black/);
  assert.match(overflow, /DrawerTitle\s+className="[^"]*text-black/);
  assert.match(channelOverflow, /<Badge[\s\S]{0,240}?data-testid="channel-overflow-visibility-badge"/);
  assert.doesNotMatch(channelOverflow, /bg-brutal-lime/);
  assert.match(channelOverflow, /channel-overflow-members-heading[\s\S]*text-foreground-strong/);
  assert.match(channelOverflow, /text-foreground-muted[^<]*[\s\S]*?membersSummary/);
  assert.match(channelOverflow, /<AvatarSlot context="panel-header" type="human" className="border-dashed text-lg">\+<\/AvatarSlot>/);
  assert.match(markdown, /border-line-muted pl-3 italic text-foreground-muted/);
  assert.doesNotMatch(markdown, /border-black\/40 pl-3 italic text-black\/70"/);
});

test("theme sweep keeps account, notification and billing actions semantic", () => {
  const settings = source("src/components/settings/SettingsPanel.tsx");
  assert.match(settings, /variant="outline"[\s\S]*settings\.account\.saveProfile/);
  assert.match(settings, /settings\.account\.saveProfile/);
  assert.match(settings, /<Badge variant="success" appearance="soft"/);
  assert.match(settings, /<Badge variant="muted" uppercase>/);
  assert.doesNotMatch(settings, /inline-flex shrink-0 border-2 border-line-strong bg-fill-muted/);
  assert.match(settings, /variant="outline"[\s\S]*settings\.notifications\.enabling/);
  assert.match(settings, /variant="outline"[\s\S]*billing\.seeAllFeaturesAndComparePlans/);
  assert.match(settings, /h-full bg-primary-strong/);
  assert.match(settings, /h-full bg-accent-strong/);
});

test("theme sweep keeps mobile links, billing summary, and search entity badges on RUI recipes", () => {
  const settings = source("src/components/settings/SettingsPanel.tsx");
  const search = source("src/components/search/MessageSearchPage.tsx");

  assert.match(settings, /render=\{\([\s\S]*mobileDownloadUrl\("android"\)[\s\S]*data-testid="mobile-download-android"/);
  assert.match(settings, /render=\{\([\s\S]*mobileDownloadUrl\("ios"\)[\s\S]*data-testid="mobile-download-ios"/);
  assert.match(settings, /<Card[\s\S]*variant="option"[\s\S]*data-testid="billing-summary-card"/);
  assert.doesNotMatch(settings, /data-testid="mobile-download-(?:android|ios)"[\s\S]*btn-brutal-sm/);
  assert.doesNotMatch(search, /ARCHIVED_CHANNEL_BADGE_CLASS/);
  assert.doesNotMatch(search, /variant="muted" appearance="outline"/);
});

test("theme sweep keeps task status and profile resize readable", () => {
  const status = source("src/components/task/StatusBadge.tsx");
  const tasks = source("src/components/task/TasksPanel.tsx");
  const statusUi = source("src/components/task/taskStatusUi.ts");
  const profile = source("src/components/profile/ProfilePanel.tsx");
  const agent = source("src/components/agent/AgentDetailPanel.tsx");
  assert.match(status, /getTaskStatusBadgeClassName/);
  assert.match(tasks, /<TaskSectionBadge status=\{ruiStatus\}/);
  assert.match(tasks, /variant="outline"[\s\S]*task\.board\.newTask/);
  assert.match(statusUi, /dark:bg-(?:warning|info|accent|success)-soft/);
  assert.match(statusUi, /theme-brutal:bg-brutal-cyan/);
  assert.match(profile, /flex: "0 0 auto"/);
  assert.match(agent, /variant="outline"[\s\S]*text-foreground-strong/);
});

test("theme sweep keeps feedback, agent channel rows, and dark sidebar active readable", () => {
  const indexCss = source("src/index.css");
  const sidebar = source("src/components/layout/Sidebar.tsx");
  const feedback = source("src/components/settings/AboutFeedbackDialog.tsx");
  const agent = source("src/components/agent/AgentDetailPanel.tsx");

  assert.match(feedback, /theme=\{themeFamily === "brutal" \? "brutal" : "elegant"\}/);
  assert.match(agent, /min-h-\[66px\][\s\S]*?theme-brutal:min-h-\[72px\]/);
  assert.match(sidebar, /SidebarRoot/);
  assert.match(sidebar, /active=\{selected\}/);
  assert.doesNotMatch(indexCss, /Legacy composition bridge/);
});

test("theme sweep closes the remaining dialog and fallback contrast leaks", () => {
  const members = source("src/components/agent/ChannelMembers.tsx");
  const avatar = source("src/components/ui/AvatarSlot.tsx");
  const stableField = source("src/components/agent/StableField.tsx");
  const reset = source("src/components/agent/ResetAgentDialog.tsx");
  const create = source("src/components/agent/CreateAgentDialog.tsx");
  const formField = source("src/components/ui/FormField.tsx");

  for (const memberSource of [members]) {
    assert.match(memberSource, /input-member-search/);
  }
  assert.match(source("src/index.css"), /\.input-member-search[\s\S]*?background: var\(--layer-panel\)/);
  assert.match(members, /variant="primary"[\s\S]*?!text-black[\s\S]*?data-testid="add-member-confirm"/);
  assert.match(members, /appearance=\{failedNow \? "soft" : "solid"\}[\s\S]*?variant=\{failedNow \? "warning" : kind === "agent" \? "information" : "accent"\}[\s\S]*?theme-brutal:bg-brutal-orange\/25 theme-brutal:text-black/);
  assert.match(members, /data-member-failure="true"/);
  assert.match(members, /aria-describedby=\{failedKeys\.has\(key\) \?/);
  // Add Member is rendered as a full-height page inside the overflow drawer.
  // Its ED surface must stay on RUI semantic layers; only the Brutal scope may
  // opt back into the legacy white/yellow/black recipe. This prevents a future
  // staging reconciliation from reintroducing the white-on-yellow/black-on-
  // dark leakage that the browser sweep caught.
  assert.match(members, /border border-line-muted bg-layer-panel[\s\S]*?theme-brutal:bg-white/);
  assert.match(members, /border-b border-line-muted bg-layer-inset[\s\S]*?theme-brutal:bg-soft-signal/);
  assert.match(members, /bg-layer-panel text-foreground-strong theme-brutal:bg-white theme-brutal:text-black/);
  assert.match(source("src/index.css"), /\.input-member-search[\s\S]*?background: var\(--layer-panel\)[\s\S]*?color: var\(--foreground-strong\)/);
  assert.match(avatar, /theme-brutal:bg-soft-signal theme-brutal:text-black/);
  assert.match(stableField, /LabelAsterisk className="ml-1 text-danger-strong theme-brutal:text-black"/);
  // `bg-info-soft` used to be pinned here because the reset mode picker tinted
  // its SELECTED option, and that tint had to be a semantic token rather than a
  // brutal colour. Task #660 (@Artea) replaced the three hand-rolled <button>s
  // with rui's RadioGroup, so there is no tint left to leak -- the guard is
  // re-anchored to the mechanism that makes a tint unnecessary, not dropped.
  // Re-introducing a hand-rolled picker turns this red again.
  assert.match(reset, /<RadioGroup\b/);
  assert.doesNotMatch(reset, /bg-(?:info|warning|danger)-soft/);
  assert.doesNotMatch(reset, /border-2 p-4/);
  // Restart confirms with `primary`, NOT `information`: rui's elegant
  // `information` pairs white on light cyan (1.91:1 in Elegant light), which this
  // dialog used to patch with `!text-black`. @Artea (task #660) asked for a
  // variant that is correct by itself instead of an override; measured in all
  // three themes, `primary` is >=12.75:1 and `warning` >=4.89:1 unassisted.
  assert.match(reset, /mode === "session" \? "warning" : "primary"/);
  assert.doesNotMatch(reset, /confirmClassName=/, "no per-call colour override on the confirm button");
  assert.match(create, /max-w-\[calc\(100vw-1rem\)\][\s\S]*?md:max-w-\[960px\]/);
  assert.match(formField, /LabelAsterisk/);
  assert.doesNotMatch(formField, /text-brutal-pink/);
});

test("dark elegant sidebar selector is bound to real product rows", () => {
  const sidebar = source("src/components/layout/Sidebar.tsx");
  assert.match(sidebar, /data-slot="sidebar-item"/);
  assert.match(sidebar, /active=\{selected\}/);
  assert.match(sidebar, /active=\{isAgentSelected\(agent\.id\)\}/);
  assert.match(sidebar, /active=\{isHumanSelected\(human\.userId\)\}/);
});

test("profile and member surfaces preserve layout while using theme-aware chrome", () => {
  const profile = source("src/components/agent/AgentDetailPanel.tsx");
  const resize = source("src/components/profile/ProfilePanel.tsx");
  const members = source("src/components/channel/ChannelMemberList.tsx");
  const nestedMembers = source("src/components/agent/ChannelMembers.tsx");

  assert.match(profile, /overflow-x-auto overflow-y-hidden scrollbar-none/);
  assert.match(profile, /className="group relative size-16 shrink-0 !p-0"/);
  // The divider moved off the resize handle onto the pane box (task #683); its
  // theme-aware colours are pinned in panelSplitDividerTheme.contract.test.ts.
  assert.match(resize, /const RESIZE_HANDLE_CLASS_NAME = "[^"]*cursor-col-resize[^"]*"/);
  assert.doesNotMatch(resize, /cursor-col-resize[^"]*border-l/);
  assert.match(members, /text-foreground-strong/);
  assert.match(members, /bg-fill-muted/);
  assert.match(members, /theme-brutal:border-black/);
  assert.match(nestedMembers, /AvatarSlot[\s\S]*badge=\{/);
});

test("message and task projections do not leak light-only black-on-white chrome", () => {
  const task = source("src/components/task/TaskCard.tsx");
  const taskHead = source("src/components/task/TaskModalHead.tsx");

  assert.match(task, /TaskCard/);
  assert.match(taskHead, /text-foreground-muted/);
  assert.doesNotMatch(taskHead, /text-black\/70/);
});

test("sidebar mute marker is non-wrapping and avatar status uses the badge primitive", () => {
  const sidebar = source("src/components/layout/Sidebar.tsx");
  assert.match(sidebar, /data-sidebar-avatar-badge="true"/);
  assert.match(sidebar, /SidebarItemMetaIcon\s+className="shrink-0"/);
  assert.doesNotMatch(sidebar, /data-sidebar-avatar-badge-shell/);
});

test("manual translation remains wired to the shared context menu action", () => {
  const message = source("src/components/message/MessageItem.tsx");
  assert.match(message, /showManualTranslationAction/);
  assert.match(message, /data-testid=\{`message-translate-menu-item-\$\{message\.id\}`\}/);
  assert.match(message, /onClick=\{handleManualTranslate\}/);
});

test("dark elegant popovers and accent submits keep readable foregrounds", () => {
  const switcher = source("src/components/ui/ServerSwitcherMenu.tsx");
  const composer = source("src/components/message/MessageInput.tsx");
  const createAgent = source("src/components/agent/CreateAgentDialog.tsx");
  const createTask = source("src/components/task/CreateTaskDialog.tsx");

  assert.match(switcher, /text-foreground-strong theme-brutal:text-black/);
  assert.match(switcher, /text-foreground-muted theme-brutal:text-black\/40/);
  assert.match(composer, /ComposerSuggestionList[\s\S]*?data-testid="mention-autocomplete-popover"[\s\S]*?ComposerSuggestionOption/);
  assert.match(composer, /ComposerSuggestionList[\s\S]*?data-testid="mention-autocomplete-popover"[\s\S]*?ComposerSuggestionTitle/);
  assert.match(composer, /ComposerSuggestionTitle className="max-w-\[12rem\] flex-\[0_1_auto\]"/);
  assert.doesNotMatch(composer, /ComposerSuggestionTitle className="[^"]*(?:min-w-\[7\.5rem\]|flex-\[1_1_12rem\])/);
  assert.match(composer, /ComposerSuggestionList[\s\S]*?data-testid="mention-autocomplete-popover"[\s\S]*?ComposerSuggestionMeta/);
  assert.match(composer, /ComposerSuggestionList[\s\S]*?data-testid="mention-autocomplete-popover"[\s\S]*?ComposerSuggestionAside/);
  assert.match(composer, /ComposerSuggestionMeta variant="code" className="max-w-\[7rem\] truncate"/);
  assert.match(composer, /ComposerSuggestionList[\s\S]*?data-testid="channel-autocomplete-popover"[\s\S]*?ComposerSuggestionTitle/);
  assert.match(composer, /data-testid="channel-autocomplete-popover"[\s\S]*?ComposerSuggestionMeta>{ch\.description}/);
  assert.match(createAgent, /dark:bg-warning-soft dark:text-warning-strong/);
  assert.match(createAgent, /variant="accent"[\s\S]*dark:!text-foreground-inverse/);
  assert.match(createTask, /<Button[\s\S]*?variant="accent"/);
});

test("page-level consumers expose the RUI semantic ladder in every major surface", () => {
  const indexCss = source("src/index.css");
  const roots = [
    source("src/components/layout/MainLayout.tsx"),
    source("src/components/layout/LeftRail.tsx"),
    source("src/components/layout/Sidebar.tsx"),
    source("src/components/message/ChatPanel.tsx"),
    source("src/components/message/ThreadPanel.tsx"),
    source("src/components/message/ChannelFilesPanel.tsx"),
    source("src/components/search/MessageSearchPage.tsx"),
    source("src/components/thread/ThreadsInbox.tsx"),
    source("src/components/task/TasksPanel.tsx"),
    source("src/components/settings/SettingsPanel.tsx"),
  ];

  assert.match(indexCss, /@import "raft-ui\/styles\.css"/);
  assert.doesNotMatch(indexCss, /Legacy composition bridge/);

  assert.match(roots[1], /AppRailRoot/);
  assert.match(roots[2], /Sidebar/);
  assert.match(roots[3], /ConversationPanelRoot/);
  assert.match(roots[4], /ThreadPanelRoot/);
  assert.match(roots[5], /FilesPanel/);
  assert.match(roots[6], /MessageSearchPage/);
  assert.match(roots[7], /ActivityInboxPanel/);
  assert.match(roots[8], /TasksPanelRoot/);
  assert.match(roots[9], /Panel/);
  assert.match(roots[0], /AppShellRoot/);
});

test("Activity shell keeps structural brutal dividers at one pixel", () => {
  const mainLayout = source("src/components/layout/MainLayout.tsx");
  const leftRail = source("src/components/layout/LeftRail.tsx");
  const threadsInbox = source("src/components/thread/ThreadsInbox.tsx");

  assert.match(leftRail, /const brutalRailDividerClassName = thinDivider && side === "left" \? "theme-brutal:!border-r" : "";/);
  assert.match(mainLayout, /<LeftRail[\s\S]{0,120}thinDivider=\{isActivityRoute\}/);
  assert.match(threadsInbox, /<ActivityInboxPanel edge="attached" className="theme-brutal:!border-l">/);
  assert.match(
    mainLayout,
    /isInboxRoute \? "theme-brutal:border-black" : "theme-brutal:border-r-2 theme-brutal:border-black"/,
    "Activity's master/detail divider should stay 1px while Search keeps its existing 2px divider",
  );
  assert.doesNotMatch(
    threadsInbox,
    /data-testid="activity-current-sidebar"[\s\S]{0,260}theme-brutal:border-r-2/,
    "Activity's own filter sidebar divider should not become a 2px brutal frame",
  );
});

test("tooltips preserve the shared content and arrow palette", () => {
  const tooltip = source("src/components/ui/Tooltip.tsx");
  // contentProps still flows through the single shared content element.
  assert.match(tooltip, /<TooltipContent \{\.\.\.contentProps\}[^>]*>\{content\}<\/TooltipContent>/);
  // An open bubble must never swallow hover/clicks aimed at what it covers
  // (header action rows, sidebar rows). Inert content moved upstream
  // (RUI 0.5.13 / rui #289), so the wrapper must stay a pure pass-through;
  // the web-side guard is the portal-layer rule pinned below:
  assert.doesNotMatch(tooltip, /pointer-events-none/, "the wrapper must not re-add overrides RUI already ships");
  assert.match(
    source("src/index.css"),
    /\[data-slot="tooltip-portal"\][\s\S]{0,120}?pointer-events:\s*none/,
    "the tooltip portal/positioner layer must stay pointer-events-none",
  );
  for (const path of [
    "layout/LeftRail", "layout/NotificationTrigger", "agent/AgentProfileOverflowMenu",
    "window/ThreadWindowRoute", "task/LegacyTaskPanel", "message/attachmentTooltip",
    "agent/AgentMcpTab",
  ]) {
    const caller = source(`src/components/${path}.tsx`);
    assert.doesNotMatch(caller, /contentProps=\{\{[^}]*className: "[^"]*(?:bg-white|bg-layer-panel)/,
      `${path} must not replace only the content background while leaving the arrow on another recipe`);
  }
  assert.doesNotMatch(source("src/components/mermaid/mermaid.css"), /\.r-mermaid-tooltip\s*\{[^}]*background:/);
});

test("thread footer reserves the available row width for its composer", () => {
  assert.match(source("src/components/message/ThreadPanel.tsx"), /<ThreadPanelFooter[\s\S]*?<div className=\{`\$\{threadChromeLayerClassName\} min-w-0 w-full flex-1`\}/);
  assert.match(source("src/components/message/MessageInput.tsx"), /<ComposerRoot[\s\S]*?min-w-0 w-full/);
});


test("Saved navigation delegates inactive and active chrome to the same SidebarItem as channels", () => {
  const sidebar = source("src/components/layout/Sidebar.tsx");
  assert.match(sidebar, /const savedEntry[\s\S]*?<SidebarItem[\s\S]*?active=\{location\.pathname\.endsWith\("\/saved"\)\}[\s\S]*?sidebarItemClass[\s\S]*?data-testid="sidebar-saved-entry"/);
});

test("classic Members Graph navigation keeps its icon and label in the shared row primitive", () => {
  const sidebar = source("src/components/layout/Sidebar.tsx");
  assert.match(
    sidebar,
    /!workspaceEnabled \? \(\s*<SidebarItem[\s\S]*?active=\{location\.pathname === `\$\{pathBase\}\/members\/graph`\}[\s\S]*?<GitBranch size=\{14\} className="shrink-0" \/>[\s\S]*?layout\.sidebar\.graph[\s\S]*?<\/SidebarItem>/,
  );
});

test("auth and onboarding surfaces ride the RUI recipes instead of hardcoded brutal chrome", () => {
  const shell = source("src/components/brand/AuthBrandShell.tsx");
  const onboardingShell = source("src/components/auth/OnboardingCreateShell.tsx");
  const login = source("src/components/auth/LoginPage.tsx");
  const register = source("src/components/auth/RegisterPage.tsx");
  const selector = source("src/components/auth/ServerSelector.tsx");
  const openGuide = source("src/components/auth/OpenInBrowserSignInGuide.tsx");

  // The shell keeps the brand bar but the surfaces themselves ride layer tokens.
  assert.match(shell, /AUTH_BRAND_SHELL_CLASS =[\s\S]*?bg-layer-canvas/);
  assert.match(shell, /theme-brutal:bg-soft-signal/);
  assert.doesNotMatch(shell, /bg-white font-display/);
  assert.match(onboardingShell, /bg-layer-canvas/);

  // Credential fields are the RUI Input primitive (theme owns border/radius/
  // invalid treatment); a raw input with brutal classes here is the regression.
  assert.match(login, /<Input[\s\S]*?id="login-email"/);
  assert.match(register, /<Input/);
  assert.doesNotMatch(login, /border-2 border-black p-2 text-base shadow-brutal-sm/);
  assert.doesNotMatch(register, /border-2 border-black p-2 text-base shadow-brutal-sm/);

  // Server tiles are the RUI option card, not a hand-rolled brutal button.
  assert.match(selector, /variant="option"[\s\S]*?server-selector-option/);
  assert.doesNotMatch(selector, /border-2 border-black bg-white p-3 text-left font-bold shadow-brutal-sm/);
  assert.doesNotMatch(selector, /className="input-brutal/);

  // The first-server intro copy rides the surface tokens; the old hardcoded
  // `text-black*` values rendered black-on-dark in Elegant Dark (task #686),
  // while Brutal keeps its exact look behind `theme-brutal:`.
  assert.match(selector, /text-foreground-strong theme-brutal:text-black"/);
  assert.match(selector, /text-foreground-muted theme-brutal:text-black\/50/);
  assert.match(selector, /text-foreground-muted theme-brutal:text-black\/65/);
  assert.doesNotMatch(selector, /(?<!theme-brutal:)text-black(?=["\/\s])/);

  // The embedded-browser guide's link keeps an accessible name even though the
  // RUI Button renders the label into its content slot.
  assert.match(openGuide, /render=\{<a[^>]*aria-label=/);
});
