export class GuestRefreshLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly maxRefreshes = 30,
    private readonly windowMs = 60_000
  ) {}

  consume(profileId: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.attempts.get(profileId) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= this.maxRefreshes) {
      this.attempts.set(profileId, recent);
      return false;
    }

    recent.push(now);
    this.attempts.set(profileId, recent);
    return true;
  }
}
