import assert from "node:assert/strict";
import { mapWithConcurrency } from "./mapWithConcurrency";

test("mapWithConcurrency keeps input order and never exceeds the limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 40 }, (_, i) => i);
  const results = await mapWithConcurrency(items, 8, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, (item * 7) % 5));
    inFlight -= 1;
    return item * 2;
  });
  assert.deepEqual(results, items.map((i) => i * 2));
  assert.equal(peak, 8);
});

test("mapWithConcurrency handles empty input, small lists and rejects like Promise.all", async () => {
  assert.deepEqual(await mapWithConcurrency([], 8, async () => 1), []);
  assert.deepEqual(await mapWithConcurrency([1, 2], 8, async (x) => x + 1), [2, 3]);
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 2, async (x) => {
      if (x === 2) throw new Error("boom");
      return x;
    }),
    /boom/,
  );
});
