import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

test("thread panel header action buttons share fixed h-7 height", () => {
  const source = readFileSync(
    resolve(repoRoot, "src/components/message/ThreadPanel.tsx"),
    "utf8",
  );


  // X close button: visible in modal (centered dialog), hidden in
  // mobile-modal (full-screen, back chevron), and `hidden lg:flex` in side
  // (msg=804c045d clarification).
  assert.match(
    source,
    /const closeButtonClassName = presentation === "modal"\s*\?\s*"flex size-7 items-center justify-center"\s*:\s*"hidden size-7 items-center justify-center lg:flex"/,
  );
});

test("profile panel header action buttons share fixed h-7 height", () => {
  const agentSource = readFileSync(
    resolve(repoRoot, "src/components/agent/AgentDetailPanel.tsx"),
    "utf8",
  );
  const humanSource = readFileSync(
    resolve(repoRoot, "src/components/member/HumanDetailPanel.tsx"),
    "utf8",
  );

  assert.match(
    humanSource,
    /className="\s*flex size-7 items-center justify-center\s*"/,
  );
  const messageButtonIdx = humanSource.search(
    /className="flex size-7 items-center justify-center"\s+aria-label=\{formatMessage\(\{ id: "member\.detail\.message" \}\)\}\s+data-slot="button"\s*>\s*<DirectMessageIcon width=\{14\} height=\{14\} \/>\s*<\/Button>/,
  );
  assert.ok(messageButtonIdx >= 0, "human profile Message icon-button anchor not found");
  assert.doesNotMatch(
    humanSource,
    /<span[^>]*>Message<\/span>/,
  );
  assert.match(
    agentSource,
    /className=\{` size-7 items-center justify-center \$\{onBack \? "flex" : "hidden md:flex"\}`\}/,
  );
  assert.match(
    humanSource,
    /className=\{` size-7 items-center justify-center \$\{onBack \? "flex" : "hidden md:flex"\}`\}/,
  );
  assert.doesNotMatch(
    agentSource,
    /h-panel-header[\s\S]{0,2000}title=\{diagnosticCopied \? "Diagnostic info copied" : "Copy Diagnostic Info"\}/,
  );
});

test("secondary panel header icon actions use the shared h-7 icon button contract", () => {
  const panelFiles = [
    "src/components/message/ChatPanel.tsx",
    "src/components/thread/ThreadsInbox.tsx",
    "src/components/saved/SavedPanel.tsx",
    "src/components/settings/SettingsPanel.tsx",
    "src/components/settings/ReleaseNotesPanel.tsx",
    "src/components/search/MessageSearchPage.tsx",
    "src/components/machine/MachineDetailPanel.tsx",
    "src/components/machine/MobileComputersPanel.tsx",
    "src/components/task/LegacyTaskPanel.tsx",
    "src/components/message/SelectShareLightbox.tsx",
  ];

  for (const file of panelFiles) {
    const source = readFileSync(resolve(repoRoot, file), "utf8");
    assert.doesNotMatch(source, /h-panel-header[\s\S]{0,1200}btn-brutal-sm[^"]*p-1\.5/);
  }

  assert.equal(existsSync(resolve(repoRoot, "src/components/ui/Button.tsx")), false);
});
