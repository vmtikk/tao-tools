/**
 * Generic order-preserving worker pool, same shape as
 * `packages/ingest/src/chain/fetchBlockRange.ts`'s inline pool (that one
 * fetches blocks specifically; this one is reused by `reconcileBalances.ts`
 * for its two `state_getStorage`-per-coldkey loops, which have the identical
 * "many independent RPC reads, latency-bound at concurrency 1" shape — see
 * that file's doc comment for the measured ~270ms/call RTT finding that
 * motivates this existing rather than just awaiting a for-loop.
 *
 * Throws on the first failure rather than returning partial results; workers
 * already in flight may still finish, but no new work is scheduled once
 * `stopped` is set.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let stopped = false;

  async function worker(): Promise<void> {
    for (;;) {
      if (stopped) return;
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (err) {
        stopped = true;
        throw err;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
