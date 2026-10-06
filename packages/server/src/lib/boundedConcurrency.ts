/**
 * Run `task` over `items` with at most `limit` in flight. Resolves when every
 * task has settled; the first rejection rejects the whole call after the
 * in-flight tasks finish, like `Promise.all` over the bounded workers.
 */
export async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await task(items[index]!, index);
    }
  });
  await Promise.all(workers);
}

/** `forEachBounded` that keeps each result at its input index. */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  await forEachBounded(items, limit, async (item, index) => {
    results[index] = await task(item, index);
  });
  return results;
}
