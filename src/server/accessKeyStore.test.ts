import { describe, expect, it } from 'vitest';
import { createSqliteAccessKeyStore } from './accessKeyStore';

describe('SQLite guest access key store', () => {
  it('stores only hashed keys and resolves active keys to one profile', () => {
    const store = createSqliteAccessKeyStore(':memory:');

    const created = store.ensureAccessKey('profile-1');
    expect('key' in created).toBe(true);
    const key = 'key' in created ? created.key : '';

    expect(store.verifyAccessKey(key)).toBe('profile-1');
    expect(store.getAccessKey('profile-1').key).toBe(key);
    expect(store.verifyAccessKey('ck_guest_wrong')).toBeNull();
    expect(store.listAccessKeys(['profile-1'])[0]).toMatchObject({ profileId: 'profile-1' });

    const rotated = store.rotateAccessKey('profile-1');
    expect(store.verifyAccessKey(key)).toBeNull();
    expect(store.verifyAccessKey(rotated.key)).toBe('profile-1');
    expect(store.setAccessKeyExpiration('profile-1', '2026-05-30T00:00:00.000Z')).toMatchObject({
      profileId: 'profile-1',
      expiresAt: '2026-05-30T00:00:00.000Z'
    });

    store.close();
  });
});
