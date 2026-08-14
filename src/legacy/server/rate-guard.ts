// RateGuard — client-side submit guard. Sliding 60s window; over-limit throws
// QuotaProtectionError before any quotaed call is made. Mirrors the lab's
// submit-only protection. In-process state; not a distributed limiter.

export class QuotaProtectionError extends Error {
  readonly code = 'quota_protection';
  constructor(perMin: number) {
    super(`rate limit: at most ${perMin} submits per minute`);
    this.name = 'QuotaProtectionError';
  }
}

export class RateGuard {
  private readonly stamps: number[] = [];

  constructor(private readonly perMin: number) {}

  // Call immediately before a quotaed submit. Throws if the window is full.
  check(now = Date.now()): void {
    const windowStart = now - 60_000;
    while (this.stamps.length && this.stamps[0]! < windowStart) {
      this.stamps.shift();
    }
    if (this.stamps.length >= this.perMin) {
      throw new QuotaProtectionError(this.perMin);
    }
    this.stamps.push(now);
  }
}
