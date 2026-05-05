import { describe, expect, it } from 'vitest';
import { createSqliteAdminStore } from './adminStore';

describe('SQLite admin store', () => {
  it('starts with admin/admin and requires the first password change', () => {
    const store = createSqliteAdminStore(':memory:', 'admin', 'admin');

    expect(store.verify('admin', 'admin')).toEqual({ ok: true, mustChangePassword: true });
    expect(store.changePassword('admin', 'admin', 'new-admin')).toEqual({ ok: true, mustChangePassword: false });
    expect(store.verify('admin', 'admin').ok).toBe(false);
    expect(store.verify('admin', 'new-admin')).toEqual({ ok: true, mustChangePassword: false });

    store.close();
  });
});
