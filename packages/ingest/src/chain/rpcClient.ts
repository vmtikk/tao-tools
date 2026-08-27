/**
 * Rate-limited, retrying Blockmachine JSON-RPC client (tao-analytics-plan.md
 * §4.2: "Build retry-with-backoff from the start. Requests over the
 * per-minute limit are rejected outright, not queued.").
 *
 * Deliberately raw `fetch`, not `@polkadot/api`'s `HttpProvider` — creating
 * an `ApiPromise` triggers a burst of its own metadata/chain-info RPC calls
 * on connect, which would blow the free tier's budget before this client
 * gets a chance to pace anything. SCALE decoding (where `@polkadot/api`
 * earns its place) happens offline in the pipeline package, against bronze
 * hex that's already on disk — it needs no live connection at all.
 *
 * Measured against the free tier on 2026-08-26: 50 request-units/minute,
 * `chain_getBlockHash` and `state_getStorage` each cost 1 RU, and a 429
 * carries `Retry-After` (seconds) plus `retry_after_ms` in the JSON body.
 * `maxRequestsPerMinute` defaults below the observed cap so the client
 * paces itself instead of relying on 429s as the normal path.
 */

export const DEFAULT_RPC_URL = "https://rpc.blockmachine.io";

export interface BlockmachineClientOptions {
  apiKey: string;
  rpcUrl?: string;
  /** Proactive client-side pacing. Default 40 — the observed free-tier cap
   * is 50 RU/min; staying under it avoids treating 429 as the normal path. */
  maxRequestsPerMinute?: number;
  /** Injectable so tests can fast-forward instead of sleeping. */
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (info: { method: string; requestCount: number }) => void;
}

export interface BlockmachineClient {
  call<T>(method: string, params: unknown[]): Promise<T>;
  requestCount: number;
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string; data?: { retry_after_ms?: number } };
}

class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Token-bucket limiter. Replaces an earlier sliding-window design that
 * tracked every call's timestamp and, once the window filled up, blocked
 * until the *oldest* call aged out all at once — which produces a bursty
 * "drain the whole freed window in a few seconds, then stall for most of a
 * minute" cycle under concurrent load, not a smooth rate. Measured against a
 * real 20,000-block sample on Blockmachine Pro (2026-08-26,
 * tao-analytics-plan.md §6): raising concurrency 30->80 under the old
 * limiter barely moved sustained throughput (104.7 -> 110.9 calls/s) because
 * the bottleneck was that stall cycle, not concurrency or Pro's real
 * capacity (zero 429s across ~180,000 calls that day).
 *
 * A token bucket refills continuously instead of releasing a whole window's
 * capacity at once, so a caller only ever waits for the fraction of a second
 * until enough tokens accrue for its own request — no long stall waiting for
 * unrelated older calls to age out. The bucket starts full (an initial burst
 * up to `maxPerMinute` is allowed, matching what a real caller bounded by
 * `concurrency` would produce anyway), then steady-state throughput is
 * limited only by the refill rate, i.e. exactly `maxPerMinute` on average.
 */
class TokenBucketLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    maxPerMinute: number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {
    this.capacity = maxPerMinute;
    this.refillPerMs = maxPerMinute / 60_000;
    this.tokens = maxPerMinute;
    this.lastRefillMs = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillMs;
    if (elapsedMs <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedMs * this.refillPerMs);
    this.lastRefillMs = now;
  }

  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = (1 - this.tokens) / this.refillPerMs;
      await this.sleep(Math.max(1, waitMs));
    }
  }
}

export function createBlockmachineClient(opts: BlockmachineClientOptions): BlockmachineClient {
  const { apiKey, rpcUrl = DEFAULT_RPC_URL, maxRequestsPerMinute = 40, sleep = defaultSleep, onProgress } = opts;
  const limiter = new TokenBucketLimiter(maxRequestsPerMinute, sleep);
  let requestCount = 0;

  async function rawCall<T>(method: string, params: unknown[]): Promise<T> {
    await limiter.acquire();
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await res.json()) as JsonRpcResponse<T>;

    if (res.status === 429) {
      const headerSeconds = Number(res.headers.get("retry-after"));
      const retryAfterMs = body.error?.data?.retry_after_ms ?? (Number.isFinite(headerSeconds) ? headerSeconds * 1000 : 5000);
      throw new RateLimitError(`RPC ${method} rate-limited`, retryAfterMs);
    }
    if (!res.ok) {
      throw new Error(`RPC ${method} failed: ${res.status} ${res.statusText}`);
    }
    if (body.error) {
      throw new Error(`RPC ${method} error ${body.error.code}: ${body.error.message}`);
    }
    if (body.result === undefined) {
      throw new Error(`RPC ${method} returned no result`);
    }
    requestCount++;
    onProgress?.({ method, requestCount });
    return body.result;
  }

  /**
   * Two distinct retry policies, not one generic backoff (this is why it
   * doesn't reuse core's `withRetry`): a 429's `Retry-After` is authoritative
   * — sleeping exactly that long and retrying is correct, not a guess, so it
   * gets a generous attempt budget. Any other failure (network blip, 5xx) is
   * genuinely unknown, so it gets a short exponential backoff and a small
   * attempt budget before surfacing to the caller, which must fail loudly
   * rather than write partial bronze (§5 Tier 3).
   */
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    const maxRateLimitAttempts = 20;
    const maxOtherAttempts = 4;
    let rateLimitAttempts = 0;
    let otherAttempts = 0;

    for (;;) {
      try {
        return await rawCall<T>(method, params);
      } catch (err) {
        if (err instanceof RateLimitError) {
          rateLimitAttempts++;
          if (rateLimitAttempts >= maxRateLimitAttempts) throw err;
          await sleep(err.retryAfterMs);
          continue;
        }
        otherAttempts++;
        if (otherAttempts >= maxOtherAttempts) throw err;
        await sleep(500 * 2 ** (otherAttempts - 1));
      }
    }
  }

  return {
    get requestCount() {
      return requestCount;
    },
    call,
  };
}
