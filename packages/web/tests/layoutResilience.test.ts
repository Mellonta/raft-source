import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

test("agent detail diagnostic text cannot squeeze identity or actions", () => {
  const source = read("src/components/agent/AgentDetailPanel.tsx");

  assert.match(source, /<div className="flex min-w-0 items-center gap-1\.5">/);
  assert.match(source, /const activityText = showDetail\s*\?\s*formatActivityText\(\s*formatMessage,\s*displayState\.activity,\s*displayState\.activityDetail,\s*displayState\.activityDetailKind,\s*\)\s*:\s*formatActivityText\(formatMessage, displayState\.activity, ""\);/);
  assert.match(source, /<Tooltip content=\{activityText\}><span className="min-w-0 truncate text-sm text-foreground-muted theme-brutal:text-black\/60 font-mono">/);
  // The description lives only in the Profile tab body; the top bar never repeats it.
  assert.doesNotMatch(source, /subtitle=\{[^}]*agent\.description/);
  assert.match(source, /titleClickProps=\{\{ title: agent\.displayName \|\| agent\.name \}\}/);
  assert.match(source, /titleSuffix=\{\s*isDeleted \? \(/);
  assert.match(source, /<Tooltip content=\{startError\}><span className="min-w-0 flex-1 truncate text-sm font-bold text-foreground-strong theme-brutal:text-black">/);
  assert.match(source, /const hasRuntimeError = activityState\?\.activity === "error" \|\| Boolean\(agent\.lastRuntimeError\);/);
  assert.match(source, /const activityErrorText = runtimeErrorKind\s*\?\s*formatMessage\(\{ id: RUNTIME_ERROR_LABEL_ID\[runtimeErrorKind\] \}\)\s*:\s*hasRuntimeError\s*\?\s*formatActivityText\(formatMessage, "error", rawRuntimeError\)\s*:\s*formatMessage\(\{ id: "activity\.status\.agentErrorFallback" \}\)/);
  assert.match(source, /const diagnosticErrorMessage = hasRuntimeError && canViewPrivateAgentSurfaces/);
  assert.match(source, /<Tooltip content=\{canViewPrivateAgentSurfaces \? activityErrorText : activityFallbackErrorText\}><span className="min-w-0 flex-1 line-clamp-2 break-words text-sm font-bold leading-snug text-foreground-strong theme-brutal:text-black">/);
  assert.match(source, /<div className="flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">/);
  // Header identity: the name row holds only the name (and its edit pencil); live
  // activity has its own line under the handle, so it can never squeeze the name.
  assert.match(source, /<div className="min-w-0 flex-1">\s*<div className="flex min-w-0 items-center gap-2">\s*<AgentHeaderName\s+agent=\{agent\}\s+onEdit=\{canManageAgent && !agent\.deletedAt \? \(\) => setEditField\("displayName"\) : undefined\}\s*\/>\s*<\/div>/);
  assert.match(source, /<div className="min-w-0 truncate text-lg font-bold leading-tight text-foreground-strong">\{agent\.displayName \|\| agent\.name\}<\/div>/);
  assert.match(source, /title=\{`@\$\{agent\.name\}`\}>@\{agent\.name\}<\/div>\s*\{\/\* Live activity has its own line under the handle, so it never squeezes the name\. \*\/\}\s*\{!agent\.deletedAt && \(\s*<div className="mt-1 min-w-0">\s*<AgentStatusBadge agentId=\{agent\.id\}/);
  assert.match(source, /<div className="truncate text-sm text-foreground-muted font-mono" title=\{`@\$\{agent\.name\}`\}>@\{agent\.name\}<\/div>/);
});

test("activity log status rows contain long error details inside a shrinkable lane", () => {
  const source = read("src/components/agent/AgentActivityLog.tsx");

  assert.match(source, /<span className="min-w-0 flex-1 text-sm text-foreground-strong theme-brutal:text-black">/);
  // The shrinkable lane is the resilience invariant: the secondary detail
  // stays wrapped in `ml-1.5 break-words text-black/60` inside the
  // `min-w-0 flex-1` parent. Inner content now routes through <RefText>
  // (activity ref linkification, task #266) but the lane is unchanged.
  assert.match(
    source,
    /<span className="ml-1\.5 break-words text-foreground-muted theme-brutal:text-black\/60">\s*<RefText text=\{secondary\} \/>\s*<\/span>/,
  );
  assert.match(source, /<div className="min-w-0 flex-1 text-sm">/);
});

test("adjacent identity headers keep names shrinkable and status/action affordances fixed", () => {
  const chatPanel = read("src/components/message/ChatPanel.tsx");
  const machinePanel = read("src/components/machine/MachineDetailPanel.tsx");
  const humanPanel = read("src/components/member/HumanDetailPanel.tsx");

  assert.match(chatPanel, /<Tooltip content=\{activityText\}>\s*<span\s+className="min-w-0 truncate text-sm text-foreground-muted font-mono"\s*>/);
  assert.match(chatPanel, /<Tooltip content=\{displayName\}><span className="min-w-0 (?:flex-1 )?truncate font-bold text-foreground-strong text-base leading-tight">\{displayName\}<\/span><\/Tooltip>/);
  assert.match(chatPanel, /title=\{isRegularChannel \? channel\.name : undefined\}/);
  assert.match(
    chatPanel,
    /const channelSubtitle =\s*isRegularChannel\s*\?\s*channel\.description\s*\?\s*<ChannelDescription description=\{channel\.description\} \/>\s*:\s*undefined\s*:\s*undefined;/,
  );
  assert.match(chatPanel, /subtitle=\{channelSubtitle\}/);

  assert.match(machinePanel, /<div className="min-w-0 truncate text-lg font-bold leading-tight text-foreground-strong theme-brutal:text-black">\{machine\.name\}<\/div>/);
  assert.match(machinePanel, /<div className="truncate text-sm text-foreground-muted theme-brutal:text-black\/50 font-mono">\{machine\.hostname\}<\/div>/);
  assert.match(machinePanel, /<Tooltip content=\{activityText\}><span\s+className="hidden max-w-\[min\(32rem,42vw\)\] truncate align-middle text-xs font-mono text-foreground-muted theme-brutal:text-black\/50 sm:inline-block"\s*>/);

  const humanNameHeaderIdx = humanPanel.search(
    /<div\s+className="min-w-0 truncate text-lg font-bold leading-tight text-foreground-strong theme-brutal:text-black"\s*>\s*\{human\.displayName \|\| human\.name\}\s*<\/div>/,
  );
  assert.ok(humanNameHeaderIdx >= 0, "human profile shrinkable name header anchor not found");
  assert.match(humanPanel, /className="inline-flex shrink-0 items-center px-1\.5 py-0\.5 text-\[10px\] font-bold uppercase border border-line-muted theme-brutal:border-black bg-gray-300 text-foreground-muted theme-brutal:text-black\/60"/);
});

test("channel descriptions collapse with the compact fixed-height panel header", () => {
  const description = read("src/components/channel/ChannelDescription.tsx");
  const globalCss = read("src/index.css");

  assert.match(
    globalCss,
    /@media \(max-height: 600px\) \{\s*\[data-slot="app-shell-root"\] \{\s*--shell-header-height:\s*48px;/,
  );
  assert.match(
    description,
    /line-clamp-2[^"\n]*\[@media\(max-height:600px\)\]:line-clamp-1/,
  );
});

test("short-viewport tab-icon hiding stays brutal-scoped (elegant items are icon-only)", () => {
  const mainLayout = read("src/components/layout/MainLayout.tsx");
  // task #707: the stdrc short-viewport adaptation hides tab icons below
  // 600px height. That is safe only in brutal (items keep a text label);
  // elegant items are icon-only (the label is sr-only), so an unscoped rule
  // blanks the entire tab bar.
  assert.match(
    mainLayout,
    /theme-brutal:\[@media\(max-height:600px\)\]:hidden/,
    "tab-icon hiding must carry the theme-brutal scope so elegant keeps its only visible content",
  );
});
