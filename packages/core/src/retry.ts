export interface RetryOptions {
  maxAttempts?: number;
  /** Base delay in ms before the first retry. Default 500. */
  baseDelayMs?: number;
  /** Multiplier applied per subsequent attempt. Default 2 (exponential). */
  factor?: number;
  /** Injectable so callers can fast-forward in tests instead of sleeping. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each retry with the attempt number (1-based) and delay. */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff wrapper (tao-analytics-plan.md §4.2: "Build
 * retry-with-backoff from the start" — over-limit requests error immediately
 * rather than queueing, so the caller's own backoff is what keeps a backfill
 * from hammering a 429). Retries `fn` up to `maxAttempts` times, re-throwing
 * the last error once attempts are exhausted.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { maxAttempts = 5, baseDelayMs = 500, factor = 2, sleep = defaultSleep, onRetry } = opts;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      const delayMs = baseDelayMs * factor ** (attempt - 1);
      onRetry?.(attempt, delayMs, err);
      await sleep(delayMs);
    }
  }
  throw lastError;
}
