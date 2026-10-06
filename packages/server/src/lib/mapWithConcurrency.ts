/**
 * Promise.all over `items` with at most `limit` calls in flight; results keep
 * the input order and the first rejection rejects the whole call (like
 * Promise.all). For per-item work that borrows pool connections: an unbounded
 * Promise.all over a long list can take every connection of the instance's
 * pool at once and queue every other request behind it.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workerCount = Math.max(1, Math.min(Math.trunc(limit), items.length));
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
