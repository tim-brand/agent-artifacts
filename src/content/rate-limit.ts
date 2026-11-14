/**
 * The client address for a rate limit, from X-Forwarded-For. Each trusted reverse proxy appends the
 * address it got the request from, so the entry `trustedProxies` from the right is the client as
 * the outermost trusted proxy saw it. Entries further left were sent by the client or by proxies we
 * do not trust, so a client must not be able to choose its bucket with them. When the chain is
 * shorter than `trustedProxies`, the left-most entry is used. Without an address, everyone shares
 * one bucket. The value is a limiter key and comes from the request, so it is cut to the length of
 * the longest address: a client must not choose how much memory a key takes.
 */
export const clientAddress = (forwardedFor: string | undefined, trustedProxies: number): string => {
  const entries = forwardedFor?.split(',') ?? [];
  const entry = entries[Math.max(0, entries.length - trustedProxies)];
  return entry?.trim().slice(0, 64) || 'unknown';
};

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
