import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteCacheStore, type CacheStore } from './cacheStore';

let store: CacheStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

describe('SQLite cache store', () => {
  it('persists profiles, messages, and cached body text', () => {
    store = createSqliteCacheStore(':memory:');

    store.upsertProfiles([
      {
        id: 'profile-1',
        profileName: 'profile-1',
        emailAddress: 'profile-1@claw.email',
        displayName: 'Profile 1',
        status: 'READY',
        lastSyncAt: null,
        lastSyncMessage: 'profile 可读取',
        unreadCount: 0
      }
    ]);
    store.upsertMessages([
      {
        id: 'message-1',
        profileId: 'profile-1',
        fromName: 'Sender',
        fromAddress: 'sender@example.com',
        subject: 'Hello',
        receivedAt: '2026-04-30T10:00:00.000Z',
        isRead: false,
        hasAttachments: false,
        snippet: 'cached',
        bodyText: ''
      }
    ]);
    store.updateMessageBody({
      id: 'message-1',
      profileId: 'profile-1',
      fromName: 'Sender',
      fromAddress: 'sender@example.com',
      subject: 'Hello',
      receivedAt: '2026-04-30T10:00:00.000Z',
      isRead: false,
      hasAttachments: false,
      snippet: 'cached',
      bodyText: 'cached body'
    });
    store.updateProfileSync('profile-1', 'READY', '同步成功', '2026-04-30T10:01:00.000Z', 1);

    expect(store.listProfiles()[0]).toMatchObject({
      id: 'profile-1',
      status: 'READY',
      lastSyncAt: '2026-04-30T10:01:00.000Z',
      unreadCount: 1
    });
    expect(store.listMessages()).toHaveLength(1);
    expect(store.getMessage('message-1')?.bodyText).toBe('cached body');
  });

  it('deletes profile metadata, message cache, sync logs, and keeps settings available', () => {
    store = createSqliteCacheStore(':memory:');
    store.upsertProfiles([profile('profile-1')]);
    store.upsertMessages([
      {
        id: 'message-1',
        profileId: 'profile-1',
        fromName: 'Sender',
        fromAddress: 'sender@example.com',
        subject: 'Hello',
        receivedAt: '2026-04-30T10:00:00.000Z',
        isRead: false,
        hasAttachments: false,
        snippet: 'cached',
        bodyText: 'body',
        bodyHtml: '<p>body</p>'
      }
    ]);
    store.insertSyncLog({ profileId: 'profile-1', status: 'SUCCESS', startedAt: '2026-04-30T10:00:00.000Z', message: 'ok' });
    store.setSetting('lastExportAt', '2026-04-30T10:00:00.000Z');

    store.deleteProfile('profile-1');

    expect(store.listProfiles()).toHaveLength(0);
    expect(store.listMessages()).toHaveLength(0);
    expect(store.getSetting('lastExportAt')).toBe('2026-04-30T10:00:00.000Z');
  });

  it('lists exportable account metadata without message bodies or secrets', () => {
    store = createSqliteCacheStore(':memory:');
    store.upsertProfiles([profile('profile-1')]);

    const records = store.listExportableProfiles('2000-01-01T00:00:00.000Z');

    expect(records).toEqual([
      expect.objectContaining({
        email: 'profile-1@claw.email',
        profileName: 'profile-1',
        displayName: 'Profile 1',
        imapHost: null,
        imapPort: null,
        lastSyncAt: null,
        syncStatus: 'READY'
      })
    ]);
    expect(JSON.stringify(records)).not.toMatch(/authCode|AUTH_CODE|t1\/|ck_live|bodyText|bodyHtml/i);
  });
});

function profile(id: string) {
  return {
    id,
    profileName: id,
    emailAddress: `${id}@claw.email`,
    displayName: `Profile ${id.split('-').at(-1)}`,
    status: 'READY' as const,
    lastSyncAt: null,
    lastSyncMessage: 'profile 可读取',
    unreadCount: 0
  };
}
