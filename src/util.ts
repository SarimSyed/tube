// Small async helpers.

/**
 * Run `fn` over `items` with bounded concurrency, preserving order.
 *
 * Spawns up to `limit` workers that pull the next item from a shared counter,
 * so at most `limit` invocations of `fn` are in flight at once.
 *
 * @param items items to map over.
 * @param limit maximum number of concurrent `fn` invocations.
 * @param fn async mapper receiving each item and its index.
 * @returns results in input order; rejects if any `fn` invocation rejects.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    // Workers share `next`, so each item is claimed exactly once across the pool.
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  // One worker per slot up to the item count; extra workers would do nothing.
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
