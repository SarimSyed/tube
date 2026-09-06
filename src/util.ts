// Small async helpers.

// In-flight promises shared by `singleFlight`: keyed by an arbitrary string so
// concurrent identical operations collapse into one upstream call.
const flights = new Map<string, Promise<unknown>>();

/**
 * Coalesce concurrent invocations of `fn` for the same `key` into one shared
 * promise (single-flight / thundering-herd protection). The first caller runs
 * `fn`; later callers made before it settles receive the same promise. The
 * entry is removed once settled (success or failure), so a failed attempt is
 * retried on the next call. Wrap only the actual network/lookup work, not any
 * surrounding TTL-cache logic that must remain atomic with it.
 */
export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = flights.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const pending = fn().finally(() => {
    // Only the current owner clears the slot, so a newer caller that replaced
    // this entry is never torn down early.
    if (flights.get(key) === pending) flights.delete(key);
  });
  flights.set(key, pending);
  return pending;
}

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
