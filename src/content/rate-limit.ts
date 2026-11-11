/** In-memory token bucket per key: `capacity` requests at once, refilled at `perMinute`. */
export function createRateLimiter(opts: { capacity: number; perMinute: number; maxKeys?: number }) {
  const { capacity, perMinute, maxKeys = 10_000 } = opts;
  const refillMs = 60_000 / perMinute;
  const buckets = new Map<string, { tokens: number; at: number }>();

  return {
    /** True when the request may go ahead. */
    take(key: string, time = Date.now()): boolean {
      if (buckets.size >= maxKeys && !buckets.has(key)) {
        // Forget buckets that have refilled; they behave as new ones anyway.
        for (const [k, b] of buckets) {
          if (b.tokens + (time - b.at) / refillMs >= capacity) buckets.delete(k);
        }
        // Still full: every bucket is busy, so start over rather than grow without bound.
        if (buckets.size >= maxKeys) buckets.clear();
      }
      const bucket = buckets.get(key) ?? { tokens: capacity, at: time };
      bucket.tokens = Math.min(capacity, bucket.tokens + (time - bucket.at) / refillMs);
      bucket.at = time;
      buckets.set(key, bucket);
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
  };
}
