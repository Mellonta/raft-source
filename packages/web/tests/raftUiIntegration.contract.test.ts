import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EXPECTED_RAFT_UI_VERSION } from "./helpers/raftUiVersion";

const repoRoot = resolve(import.meta.dirname, "..");

function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

test("web app installs raft-ui global CSS and providers", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(packageJson.dependencies?.["raft-ui"], EXPECTED_RAFT_UI_VERSION);

  const css = read("src/index.css");
  assert.match(css, /@import "raft-ui\/styles\.css";/);
  assert.match(css, /@source "\.\.\/node_modules\/raft-ui\/dist";/);

  // PR #8269 made AppProviders the single source of truth for the root provider
  // tree (the desktop entry mounts the same component; 0.1.29 crashed because
  // main.tsx had hand-copied it). The raft-ui providers therefore live in
  // AppProviders.tsx, and main.tsx must only mount <AppProviders> — asserting
  // the wiring in main.tsx again would contradict tests/appProviders.behavior.
  const providers = read("src/AppProviders.tsx");
  // Staging replaced raft-ui's ToastProvider with the app-local
  // LocalizedToastProvider; the theme contract still pins TooltipProvider.
  assert.match(providers, /import \{[^}]*\bTooltipProvider\b[^}]*\} from "raft-ui";/);
  assert.match(providers, /import \{ AppThemeProvider \} from "\.\/theme\/AppThemeProvider";/);
  assert.match(providers, /<AppThemeProvider>/);
  assert.match(providers, /<TooltipProvider(?:\s+[^>]*)?>/);
  assert.match(providers, /<LocalizedToastProvider>/);

  const main = read("src/main.tsx");
  assert.match(main, /<AppProviders(?:\s+[^>]*)?>/, "main.tsx mounts the shared AppProviders");
  assert.doesNotMatch(main, /import \{[^}]*\b(?:TooltipProvider|AppThemeProvider)\b[^}]*\}|<(?:TooltipProvider|AppThemeProvider)\b/, "main.tsx must not relist providers that AppProviders owns");
});

test("web typography follows raft-ui/fonts.css font definition contract", () => {
  const css = read("src/index.css");

  assert.match(css, /@import "raft-ui\/fonts\.css";/);
  assert.doesNotMatch(css, /@import[^;]*assets\/fonts\/fonts\.css/);
  assert.doesNotMatch(css, /family=Space\+Grotesk/);

  assert.match(css, /--font-display:\s*var\(--font-heading/);
  assert.match(css, /--font-mono:\s*var\(--mono-font/);
  assert.match(css, /font-family:\s*var\(--font-sans/);
  assert.doesNotMatch(css, /--(font-[a-z]+):\s*var\(--\1(?![\w-])/, "font variables must not self-reference");

  const selectScreenshot = read("src/utils/selectScreenshot.ts");
  assert.match(selectScreenshot, /'Space Grotesk', 'Space Mono', ui-monospace, sans-serif/);
  assert.match(selectScreenshot, /'Space Mono', ui-monospace, monospace/);
});

test("segmented controls use raft-ui directly at callsites", () => {
  for (const file of [
    "src/components/agent/ExternalSetupTabSegmentedControl.tsx",
    "src/components/agent/AgentWorkspace.tsx",
    "src/components/channel/CreateChannelDialog.tsx",
    "src/components/settings/SettingsPanel.tsx",
    "src/components/settings/SettingsSegmentedControls.tsx",
    "src/components/task/TaskFilterSegmentedControl.tsx",
    "src/components/task/TasksPanel.tsx",
    "src/components/thread/ThreadsInbox.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /from "raft-ui";/, `${file} should import raft-ui directly`);
    assert.doesNotMatch(
      source,
      /from "\.\.\/ui\/SegmentedControl";/,
      `${file} should not use the local SegmentedControl adapter`,
    );
  }

  for (const file of [
    "src/components/message/ChatPanel.tsx",
    "src/components/message/ThreadPanel.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /import\s*\{[^}]*\btoast\b[^}]*\}\s*from\s*"raft-ui";/, `${file} should import raft-ui toast directly`);
    assert.match(source, /SELECTION_TOAST_OPTIONS\s*=\s*\{\s*icon:\s*false,\s*dismissible:\s*false,?\s*\}\s*as const;/);
    assert.doesNotMatch(source, /showSelectionToast/, `${file} should call raft-ui toast APIs directly`);
    assert.doesNotMatch(source, /data-testid="(?:thread-)?forward-toast"/, `${file} should not render local forward toast wrappers`);
  }

  const utils = read("src/components/message/forwardSelectionUtils.ts");
  assert.doesNotMatch(utils, /scheduleSelectionToastClear/, "forward selection should not keep a local toast timeout helper");
});

test("select fields use raft-ui directly at business callsites", () => {
  for (const file of [
    "src/components/agent/CreateAgentDialog.tsx",
    "src/components/agentMigration/AgentMigrationDialog.tsx",
    "src/components/agent/RuntimeConfigFields.tsx",
    "src/components/settings/SettingsPanel.tsx",
    "src/pages/HumanLoginSetupPage.tsx",
    "src/pages/IntegrationInvitePage.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /from "raft-ui";/, `${file} should import raft-ui directly`);
    assert.match(source, /<Select[\s>]/, `${file} should render raft-ui Select at the callsite`);
    assert.doesNotMatch(source, /SelectItemLeading/, `${file} should not reserve an empty leading slot for text-only options`);
    assert.doesNotMatch(
      source,
      /from "\.\.?\/(?:\.\.\/)?(?:components\/)?Select";/,
      `${file} should not use the deleted local Select adapter`,
    );
  }

  const migrationDialog = read("src/components/agentMigration/AgentMigrationDialog.tsx");
  assert.doesNotMatch(
    migrationDialog,
    /<select[\s>]/,
    "agent migration must not fall back to a native select outside the component library",
  );
});

test("select roots are wrapped when adjacent layout siblings matter", () => {
  const invite = read("src/pages/IntegrationInvitePage.tsx");

  assert.match(
    invite,
    /<div className="mt-3 grid gap-3 md:grid-cols-\[1fr_auto\] md:items-end">\s*<div className="min-w-0">\s*<Select[\s\S]*?items=\{manageableServerOptions\}/,
    "integration invite target select should not leak its hidden input into the install grid",
  );
});
