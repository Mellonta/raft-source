import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The computer row's status dot intentionally overhangs its icon tile by 4px
// (absolute -right-1 -top-1). RUI Card's root is overflow-hidden, so the tile
// must opt back into overflow-visible or the dot is clipped. This regressed
// twice already (a fix lands, a later merge drops it silently) — pin the pair
// so the third time fails loudly instead of shipping a clipped dot.
test("computer row status dot overhang is never clipped by its icon tile", () => {
  const sidebar = readFileSync(
    new URL("../src/components/layout/Sidebar.tsx", import.meta.url),
    "utf8",
  );

  const tile = sidebar.match(
    /<Card className="([^"]*)">\s*<Monitor/,
  );
  assert.ok(tile, "computer row icon tile (Card wrapping Monitor) not found");
  assert.match(tile[1], /\boverflow-visible\b/, "the icon tile must allow the overhanging dot to escape RUI Card's overflow-hidden");

  assert.match(
    sidebar,
    /<StatusDot\s+className="absolute -right-1 -top-1"/,
    "the computer status dot must keep its by-design 4px overhang",
  );
});
