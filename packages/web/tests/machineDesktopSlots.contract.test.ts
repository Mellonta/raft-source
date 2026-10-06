import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Desktop task #124: the Electron shell must NOT substitute its own card for
// the machine it runs on. It decorates the web's own ComputerRow (a small
// "This device" badge in the meta line) and puts the local Computer-service
// controls in the machine detail panel, where every machine's actions live.
// Both need a stable, empty host slot in the web markup. Pin the pair so a
// refactor cannot silently drop them (the desktop would fall back to nothing).
test("computer row exposes an empty meta-line host slot keyed by machine id", () => {
  const sidebar = readFileSync(new URL("../src/components/layout/Sidebar.tsx", import.meta.url), "utf8");
  const slot = sidebar.match(/<span\s+data-testid=\{`computer-list-item-\$\{machine\.id\}-meta-slot`\}\s+data-machine-id=\{machine\.id\}\s+className="([^"]*)"\s*\/>/);
  assert.ok(slot, "ComputerRow meta-line host slot not found");
  assert.match(slot[1], /\bshrink-0\b/, "the slot must never take width from the name (name priority)");
  assert.match(slot[1], /\bempty:hidden\b/, "the slot is invisible on the web");
});

test("machine detail panel exposes an empty local-controls host slot keyed by machine id", () => {
  const panel = readFileSync(new URL("../src/components/machine/MachineDetailPanel.tsx", import.meta.url), "utf8");
  const slot = panel.match(/<div data-testid="machine-detail-local-slot" data-machine-id=\{machine\.id\} className="([^"]*)" \/>/);
  assert.ok(slot, "MachineDetailPanel local host slot not found");
  assert.match(slot[1], /\bempty:hidden\b/);
  // It sits between the profile block and the Name section: actions belong
  // with the identity, above the editable fields.
  const profile = panel.indexOf("{/* Profile info");
  const name = panel.indexOf("{/* Name */}");
  const at = panel.indexOf('data-testid="machine-detail-local-slot"');
  assert.ok(profile >= 0 && name > profile && at > profile && at < name, "slot placed after the profile block and before the Name section");
});
