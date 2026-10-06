import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Every surface that closes on an outside press must declare itself with the
// dismiss-layer marker (src/components/ui/dismissLayer.ts), so hosts that own
// native chrome — the desktop shell's draggable title bar — can tell a layer is
// open. This scan catches the hand-rolled pattern (a document / window
// mousedown or pointerdown listener) landing in a file that declares nothing.
// It proves presence, not placement; behaviour tests cover the real elements.

const SRC = path.resolve(__dirname, "../src");
const OUTSIDE_PRESS = /(document|window)\.addEventListener\(\s*["'](mousedown|pointerdown)["']/;
// Files whose listener is NOT an outside-press dismissal (state each reason).
const NOT_A_LAYER = new Map<string, string>([
  ["components/message/MessageSelectionShortcut.tsx", "selection gesture tracking"],
  ["components/message/ThreadPanel.tsx", "thread search scope tracking"],
  ["store/messageStore.ts", "auto-read tab claim on user activity"],
]);
// A file satisfies the contract by spreading the marker itself or by rendering
// a shared component that carries it.
const CARRIERS = [/dismissLayerProps/, /<SelectionPopover\b/, /<DismissBackdrop\b/, /<Modal\b/, /<Lightbox\b/];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

test("every outside-press dismissal lives in a file that declares the dismiss-layer marker", () => {
  const offenders: string[] = [];
  const seen: string[] = [];
  for (const file of walk(SRC)) {
    const source = readFileSync(file, "utf8");
    if (!OUTSIDE_PRESS.test(source)) continue;
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    seen.push(rel);
    if (NOT_A_LAYER.has(rel)) continue;
    if (CARRIERS.some((re) => re.test(source))) continue;
    offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `outside-press listeners without a dismiss-layer marker (mark the popup element with dismissLayerProps, or list the file in NOT_A_LAYER with its reason):\n  ${offenders.join("\n  ")}`);
  // Allowlist hygiene: an entry that no longer has a listener is stale.
  for (const rel of NOT_A_LAYER.keys()) assert.ok(seen.includes(rel), `NOT_A_LAYER entry is stale (no outside-press listener any more): ${rel}`);
});
