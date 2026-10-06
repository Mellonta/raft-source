import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

function walkSourceFiles(dir: string, fileList: string[] = []): string[] {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walkSourceFiles(fullPath, fileList);
    } else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

/**
 * Brutal-only palette classes: fixed brutal colours / geometry that must only
 * ever appear behind a `theme-brutal:` scope on theme-following surfaces.
 *
 * This is the yardstick that caught the staging-sync reverts (B22/B25): the
 * search page silently fell back to unscoped `border-black` / `bg-white` /
 * `text-black` / `shadow-brutal-*`, which is invisible in Brutal but breaks
 * Elegant and Elegant dark. Counting unscoped occurrences and ratcheting the
 * two rebuilt files at zero makes that class of regression detectable again.
 */
const BRUTAL_ONLY =
  /\b(?:bg|text|border|shadow|outline|ring|divide)-(?:brutal-[a-z0-9-]+)\b|\b(?:bg-white|text-black|border-black)(?:\/\d+)?\b|\bbtn-brutal[a-z0-9-]*/g;

/**
 * Unscoped soft-signal palette classes: brand yellow / accent tokens that must
 * only appear behind `theme-brutal:` on surfaces following themes.
 *
 * F4 guard: catches newly injected unscoped soft-signal classes across the app.
 */
const SOFT_SIGNAL =
  /\b(?:bg|text|border|outline|decoration)-soft-signal(?:\/\d+)?\b/g;

/** Whitespace-delimited class token containing the match, so `theme-brutal:`
 *  anywhere in the variant chain (`theme-brutal:hover:bg-black`) counts as
 *  scoped. */
function classTokenAt(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const lineEndRaw = text.indexOf("\n", index);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  const line = text.slice(lineStart, lineEnd);
  const rel = index - lineStart;
  const before = line.slice(0, rel);
  const headMatch = before.match(/\S*$/);
  const head = headMatch ? headMatch[0] : "";
  const tail = line.slice(rel).match(/^\S*/)?.[0] ?? "";
  return head + tail;
}

function unscopedClasses(path: string, regex: RegExp): string[] {
  const raw = source(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const offenders: string[] = [];
  for (const match of raw.matchAll(regex)) {
    const token = classTokenAt(raw, match.index ?? 0);
    if (token.includes("theme-brutal:")) continue;
    offenders.push(token.trim());
  }
  return offenders;
}

test("rebuilt search / settings / modal surfaces keep brutal-palette classes scoped", () => {
  const RATCHET_LIMITS: [path: string, maxAllowed: number][] = [
    ["src/components/search/MessageSearchPage.tsx", 0],
    ["src/components/settings/ReleaseNotesPanel.tsx", 0],
    ["src/components/layout/SidebarConversationFinder.tsx", 0],
    ["src/components/member/InviteHumanDialog.tsx", 0],
    ["src/components/settings/SettingsPanel.tsx", 21],
    ["src/components/message/ThreadPanel.tsx", 7],
    ["src/components/message/MessageInput.tsx", 3],
    ["src/components/message/ChatPanel.tsx", 3],
    ["src/components/settings/AppearanceThemePicker.tsx", 2],
    ["src/components/message/AttachmentChip.tsx", 0],
    ["src/components/agent/AgentWorkspace.tsx", 0],
    ["src/pages/PublicServerPage.tsx", 1],
    // F3: LeftRail brand signature surface intentionally retains 5 brutal chrome classes
    ["src/components/layout/LeftRail.tsx", 5],
  ];

  for (const [path, maxAllowed] of RATCHET_LIMITS) {
    const offenders = unscopedClasses(path, BRUTAL_ONLY);
    assert.ok(
      offenders.length <= maxAllowed,
      `${path} exceeded unscoped brutal class limit: ${offenders.length} > ${maxAllowed}. ` +
        `Put them behind theme-brutal: or replace with semantic tokens:\n${offenders.join("\n")}`,
    );
  }
});

test("surfaces keep soft-signal classes scoped or registered in allowlist", () => {
  // Allowlist of files permitted to contain unscoped soft-signal with upper bound ratchets.
  // Any file not in this map defaults to 0 max allowed.
  const SOFT_SIGNAL_ALLOWLIST: Record<string, number> = {
    // F3: LeftRail brand signature surface intentionally retains 2 soft-signal tokens (Grace ruling)
    "src/components/layout/LeftRail.tsx": 2,
    // A1 surfaces (intentional artwork/palette pages)
    "src/pages/PaletteAuditPage.tsx": 9,
    "src/components/auth/ServerCreatePreview.tsx": 4,
    "src/components/auth/AccountIdentitySetupPage.tsx": 3,
    "src/components/onboarding/ServerSetupHandoffStep.tsx": 1,
    // Legacy mapping lookup table
    "src/components/ConfirmDialog.tsx": 1,
    // Surfaces cleaned and locked to 0
    "src/components/settings/SettingsPanel.tsx": 0,
    "src/components/handoff/HandoffCreateFlow.tsx": 0,
    "src/components/settings/AppNotificationsControls.tsx": 0,
    "src/components/task/LegacyTaskPanel.tsx": 0,
    "src/components/agent/AgentRemindersSection.tsx": 0,
    "src/components/message/attachmentPreviewSurfaces.tsx": 0,
  };

  const allSrcFiles = walkSourceFiles(resolve(root, "src"));
  for (const fullPath of allSrcFiles) {
    const relPath = relative(root, fullPath);
    const maxAllowed = SOFT_SIGNAL_ALLOWLIST[relPath] ?? 0;
    const offenders = unscopedClasses(relPath, SOFT_SIGNAL);
    assert.ok(
      offenders.length <= maxAllowed,
      `${relPath} exceeded unscoped soft-signal limit: ${offenders.length} > ${maxAllowed}. ` +
        `Put them behind theme-brutal: or replace with semantic tokens:\n${offenders.join("\n")}`,
    );
  }
});
