import { describe, expect, it } from 'vitest';
import { GuestRefreshLimiter } from './guestRefreshLimiter';

describe('GuestRefreshLimiter', () => {
  it('allows thirty guest refreshes per minute for one mailbox', () => {
    const limiter = new GuestRefreshLimiter(30, 60_000);

    for (let index = 0; index < 30; index += 1) {
      expect(limiter.consume('profile-1', index)).toBe(true);
    }

    expect(limiter.consume('profile-1', 30_000)).toBe(false);
    expect(limiter.consume('profile-1', 60_001)).toBe(true);
  });
});
