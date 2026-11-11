interface Bucket {
  tokens: number;
  at: number;
}

export interface Take {
  ok: boolean;
  retryAfter: number;
}

/** In-memory token buckets, one per key. A single gateway process owns them. */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private now: () => number = () => Date.now()) {}

  take(key: string, capacity: number, perMinute: number, cost = 1): Take {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: capacity, at: now };
    bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.at) / 60000) * perMinute);
    bucket.at = now;
    this.buckets.set(key, bucket);
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      this.sweep();
      return { ok: true, retryAfter: 0 };
    }
    return { ok: false, retryAfter: Math.max(1, Math.ceil(((cost - bucket.tokens) / perMinute) * 60)) };
  }

  private sweep(): void {
    if (this.buckets.size < 5000) return;
    const cutoff = this.now() - 600000;
    for (const [key, bucket] of this.buckets) if (bucket.at < cutoff) this.buckets.delete(key);
  }
}
