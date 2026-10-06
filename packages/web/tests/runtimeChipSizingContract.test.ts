import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

function readSource(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

// The settings row delegates its visual scale and palette to RUI. These
// attributes are the public component contract; pixel equality is checked in
// the browser because a source check cannot measure the theme recipe.
test("agent runtime configuration badges use standard RUI props without local visual overrides", () => {
  const source = readSource("src/components/agent/AgentDetailPanel.tsx");
  const runtime = [...source.matchAll(/<RuntimeAccountUsageGateChip\b([^>]*?)>/g)];
  assert.equal(runtime.length, 1);
  assert.match(runtime[0]![1], /appearance="solid"/);
  assert.match(runtime[0]![1], /variant="information"/);
  assert.doesNotMatch(runtime[0]![1], /\b(?:className|style)=/);

  for (const [field, variant] of [["model", "accent"], ["reasoning", "primary"], ["mode", "warning"]]) {
    const label = `label={formatMessage({ id: "agent.runtimeConfig.${field}" })}`;
    const index = source.indexOf(label);
    assert.notEqual(index, -1, `${field} label missing`);
    // The value is either a `value={…}` prop (KeyValueRow) or the first child of an
    // InfoRow (label | value rows); either way it must be the standard Badge.
    const badge = source.slice(index).match(/(?:value=\{\s*|<\/?InfoRow[^>]*>\s*|label=\{[^}]*\}\)\}>\s*)<Badge\b([^>]*?)>/);
    assert.ok(badge, `${field} must use the standard Badge`);
    assert.match(badge[1], /appearance="soft"/);
    assert.ok(badge[1].includes(`variant="${variant}"`));
    assert.doesNotMatch(badge[1], /\b(?:className|style)=/);
  }
});

test("machine runtime chips use the shared badge recipe without forcing a legacy border or height", () => {
  const source = readSource("src/components/machine/MachineDetailPanel.tsx");
  const branch = source.match(/const chipClassName = detected([\s\S]*?);/);
  assert.ok(branch);
  assert.match(branch[1], /bg-info-soft text-info-strong/);
  assert.match(branch[1], /bg-fill-muted text-foreground-muted/);
  assert.doesNotMatch(branch[1], /h-6|border-2/);
});
