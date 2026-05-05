import { describe, expect, it } from 'vitest';
import { createSqliteMailboxExpirationStore } from './mailboxExpirationStore';

describe('SQLite mailbox expiration store', () => {
  it('stores mailbox subscription dates and reports expiration', () => {
    const store = createSqliteMailboxExpirationStore(':memory:');

    store.setExpiration('profile-1', '2026-05-30T00:00:00.000Z');

    expect(store.getExpiration('profile-1')).toEqual({ profileId: 'profile-1', expiresAt: '2026-05-30T00:00:00.000Z' });
    expect(store.isExpired('profile-1', new Date('2026-05-29T23:59:00.000Z'))).toBe(false);
    expect(store.isExpired('profile-1', new Date('2026-05-30T00:00:00.000Z'))).toBe(true);

    store.close();
  });
});
