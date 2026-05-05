import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRealClawCliAdapter } from './clawCliAdapter';
import { parseClawEmailAuthToken, redactClawSecrets } from './clawAuthTokenParser';
import { analyzeClawImapPayloadShape, createHttpClawAuthPayloadFetcher, parseClawImapCredentials } from './clawAuthPayloadFetcher';
import { createSqliteCacheStore } from './cacheStore';
import { createMemorySecretStore } from './secretStore';
import type { MailDetail, MailboxProfile } from '../shared/types';

describe('ClawEmail IMAP-only adapter', () => {
  it.each([
    ['pure token', 't1/xxxx', 't1/xxxx'],
    ['full npx command', 'npx "@clawemail/claw-setup@latest" --auth-url "t1/xxxx"', 't1/xxxx'],
    [
      'full curl command',
      'curl -sSL http://claw.163.com/skills-hub/sh/hermes-email-setup.sh | bash -s -- --auth-url "t1/yyyy" --home-email "me@example.com"',
      't1/yyyy'
    ],
    ['extra spaces', '   npx   "@clawemail/claw-setup@latest"    --auth-url    "t1/spaced"   ', 't1/spaced'],
    ['single quotes', "npx '@clawemail/claw-setup@latest' --auth-url 't1/single'", 't1/single'],
    ['double quotes', 'npx "@clawemail/claw-setup@latest" --auth-url "t1/double"', 't1/double'],
    ['token embedded in clipboard text', '复制这段官方命令后导入：t1/clipboard-token。', 't1/clipboard-token']
  ])('parses %s input', (_label, input, expected) => {
    expect(parseClawEmailAuthToken(input)).toBe(expected);
  });

  it('rejects invalid http links and redacts secrets', () => {
    expect(parseClawEmailAuthToken('https://example.com/not-a-claw-token')).toBeNull();
    const redacted = redactClawSecrets('failed --auth-url "t1/secret" --password pass123 ck_live_secret');
    expect(redacted).not.toContain('secret');
    expect(redacted).not.toContain('pass123');
    expect(redacted).toContain('[已隐藏]');
  });

  it('parses IMAP credentials from colon-line payload without using API keys', () => {
    expect(parseClawImapCredentials('__apikey__:default:ck_ignored\nhermes:hermes:AUTH_CODE\n')).toEqual([
      {
        profileId: 'hermes@claw.163.com',
        profileName: 'hermes',
        email: 'hermes@claw.163.com',
        displayName: 'hermes@claw.163.com',
        authCode: 'AUTH_CODE',
        imapHost: 'claw.163.com',
        imapPort: 993,
        imapSecure: true
      }
    ]);
  });

  it('analyzes IMAP payload shape without exposing authCode values', () => {
    const shape = analyzeClawImapPayloadShape('__apikey__:default:ck_ignored\nhermes:hermes:AUTH_CODE\nempty:empty:\n');

    expect(shape).toEqual({
      format: 'colon-lines',
      nonEmptyLineCount: 3,
      colonLineCount: 3,
      accountLineCount: 2,
      accountLinesWithAuthCode: 1,
      hasDoubleUnderscoreApiKey: true,
      hasEmail: false,
      jsonKeys: []
    });
    expect(JSON.stringify(shape)).not.toContain('AUTH_CODE');
    expect(JSON.stringify(shape)).not.toContain('hermes');
  });

  it('parses IMAP credentials from JSON payloads', () => {
    const credentials = parseClawImapCredentials(
      JSON.stringify({
        accounts: [{ accountId: 'profile-a', email: 'a@claw.163.com', displayName: 'A', authCode: 'AUTH_CODE' }]
      })
    );

    expect(credentials).toMatchObject([{ profileId: 'a@claw.163.com', email: 'a@claw.163.com', authCode: 'AUTH_CODE' }]);
  });

  it('requests auth payloads through the official Hermes client mode', async () => {
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrls.push(String(input));
      return new Response('hermes:hermes:AUTH_CODE\n', { status: 200 });
    }) as typeof fetch;

    try {
      const payload = await createHttpClawAuthPayloadFetcher().fetch('t1/secret');

      expect(payload).toBe('hermes:hermes:AUTH_CODE');
      expect(requestedUrls).toEqual(['https://u.163.com/t1/secret?client=hermes']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('initializes a mailbox through token fetch, IMAP verification, keychain storage, and SQLite metadata', async () => {
    const store = createSqliteCacheStore(':memory:');
    const secretStore = createMemorySecretStore();
    const imapAdapter = createFakeImapAdapter();
    const adapter = createRealClawCliAdapter({
      cacheStore: store,
      secretStore,
      imapAdapter,
      payloadFetcher: {
        async fetch(token) {
          expect(token).toBe('t1/secret');
          return 'hermes:hermes:AUTH_CODE\n';
        }
      }
    });

    const result = await adapter.initializeProfile({
      authUrl: 'curl -sSL http://example.invalid/install.sh | bash -s -- --auth-url "t1/secret"'
    });

    expect(result.ok).toBe(true);
    expect(imapAdapter.verifiedPasswords).toEqual(['AUTH_CODE']);
    expect(await secretStore.getPassword('hermes@claw.163.com')).toBe('AUTH_CODE');
    expect(store.listProfiles()).toMatchObject([
      {
        id: 'hermes@claw.163.com',
        emailAddress: 'hermes@claw.163.com',
        imapHost: 'claw.163.com',
        imapPort: 993,
        status: 'READY'
      }
    ]);
    expect(JSON.stringify(store.listProfiles())).not.toContain('AUTH_CODE');
    store.close();
  });

  it('keeps 12 different mailboxes even when payload account type is repeated', async () => {
    const store = createSqliteCacheStore(':memory:');
    const secretStore = createMemorySecretStore();
    const adapter = createRealClawCliAdapter({
      cacheStore: store,
      secretStore,
      imapAdapter: createFakeImapAdapter(),
      payloadFetcher: {
        async fetch(token) {
          const index = Number(token.split('/')[1]);
          return `mailbox-${index}:agent:AUTH_CODE_${index}\n`;
        }
      }
    });

    for (let index = 1; index <= 12; index += 1) {
      const result = await adapter.initializeProfile({ authUrl: `t1/${index}` });
      expect(result.ok).toBe(true);
    }

    const storedProfiles = store.listProfiles();
    expect(storedProfiles).toHaveLength(12);
    expect(new Set(storedProfiles.map((profile) => profile.emailAddress)).size).toBe(12);
    expect(new Set(storedProfiles.map((profile) => profile.id)).size).toBe(12);
    expect(await secretStore.getPassword('mailbox-12@claw.163.com')).toBe('AUTH_CODE_12');
    store.close();
  });

  it('does not fetch payloads for invalid pasted input', async () => {
    const adapter = createRealClawCliAdapter({
      payloadFetcher: {
        async fetch() {
          throw new Error('should not fetch');
        }
      },
      secretStore: createMemorySecretStore(),
      imapAdapter: createFakeImapAdapter()
    });

    const result = await adapter.initializeProfile({ authUrl: 'https://example.com/nope' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('未识别到有效的 ClawEmail auth-url');
  });

  it('rejects payloads without IMAP authCode', async () => {
    const adapter = createRealClawCliAdapter({
      payloadFetcher: { async fetch() { return '__apikey__:default:ck_ignored\nhermes:hermes:\n'; } },
      secretStore: createMemorySecretStore(),
      imapAdapter: createFakeImapAdapter()
    });

    const result = await adapter.initializeProfile({ authUrl: 't1/secret' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('WS/API-key 模式');
    expect(result.message).not.toContain('ck_ignored');
  });

  it('previews duplicate mailboxes and can skip existing credentials', async () => {
    const store = createSqliteCacheStore(':memory:');
    const secretStore = createMemorySecretStore({ 'hermes@claw.163.com': 'OLD_AUTH_CODE' });
    store.upsertProfiles([profile('hermes@claw.163.com')]);
    const adapter = createRealClawCliAdapter({
      cacheStore: store,
      secretStore,
      imapAdapter: createFakeImapAdapter(),
      payloadFetcher: { async fetch() { return 'hermes:agent:NEW_AUTH_CODE\n'; } }
    });

    const preview = await adapter.previewInitializeProfile({ authUrl: 't1/secret' });
    const result = await adapter.initializeProfile({ authUrl: 't1/secret', duplicateAction: 'skip' });

    expect(preview.ok).toBe(true);
    expect(preview.hasDuplicates).toBe(true);
    expect(preview.accounts).toMatchObject([{ emailAddress: 'hermes@claw.163.com', exists: true }]);
    expect(result.items).toMatchObject([{ ok: true, emailAddress: 'hermes@claw.163.com', action: 'skipped' }]);
    expect(await secretStore.getPassword('hermes@claw.163.com')).toBe('OLD_AUTH_CODE');
    store.close();
  });

  it('imports valid accounts from a multi-account payload even when one account fails', async () => {
    const store = createSqliteCacheStore(':memory:');
    const secretStore = createMemorySecretStore();
    const adapter = createRealClawCliAdapter({
      cacheStore: store,
      secretStore,
      imapAdapter: createFakeImapAdapter({ failVerifyEmails: ['bad@claw.163.com'] }),
      payloadFetcher: { async fetch() { return 'good:agent:GOOD_AUTH_CODE\nbad:agent:BAD_AUTH_CODE\n'; } }
    });

    const result = await adapter.initializeProfile({ authUrl: 't1/secret' });

    expect(result.ok).toBe(false);
    expect(result.items).toMatchObject([
      { ok: true, emailAddress: 'good@claw.163.com', action: 'added' },
      { ok: false, emailAddress: 'bad@claw.163.com', action: 'failed' }
    ]);
    expect(store.listProfiles()).toMatchObject([{ id: 'good@claw.163.com' }]);
    expect(await secretStore.getPassword('good@claw.163.com')).toBe('GOOD_AUTH_CODE');
    expect(await secretStore.getPassword('bad@claw.163.com')).toBeNull();
    store.close();
  });

  it('reports keychain write failures without saving the profile', async () => {
    const store = createSqliteCacheStore(':memory:');
    const secretStore = {
      async setPassword() {
        throw new Error('keychain denied');
      },
      async getPassword() {
        return null;
      },
      async deletePassword() {}
    };
    const adapter = createRealClawCliAdapter({
      cacheStore: store,
      secretStore,
      imapAdapter: createFakeImapAdapter(),
      payloadFetcher: { async fetch() { return 'hermes:agent:AUTH_CODE\n'; } }
    });

    const result = await adapter.initializeProfile({ authUrl: 't1/secret' });

    expect(result.ok).toBe(false);
    expect(result.items?.[0]?.message).toContain('系统 Keychain / Credential Store 写入失败');
    expect(store.listProfiles()).toHaveLength(0);
    store.close();
  });

  it('refreshes messages and caches body through IMAP', async () => {
    const store = createSqliteCacheStore(':memory:');
    const secretStore = createMemorySecretStore({ hermes: 'AUTH_CODE' });
    const imapAdapter = createFakeImapAdapter();
    store.upsertProfiles([
      {
        id: 'hermes',
        profileName: 'hermes',
        emailAddress: 'hermes@claw.163.com',
        displayName: 'hermes@claw.163.com',
        imapHost: 'claw.163.com',
        imapPort: 993,
        status: 'READY',
        lastSyncAt: null,
        lastSyncMessage: 'ready',
        unreadCount: 0
      }
    ]);
    const adapter = createRealClawCliAdapter({ cacheStore: store, secretStore, imapAdapter });

    const refresh = await adapter.refreshProfile('hermes');
    const summary = store.listMessages()[0];
    const detail = await adapter.getMessage(summary.id);

    expect(refresh.ok).toBe(true);
    expect(summary.subject).toBe('Hello');
    expect(detail.bodyText).toBe('Hello body');
    expect(store.getMessage(summary.id)?.bodyText).toBe('Hello body');
    store.close();
  });

  it('keeps cached messages when IMAP refresh fails', async () => {
    const store = createSqliteCacheStore(':memory:');
    const secretStore = createMemorySecretStore({ hermes: 'AUTH_CODE' });
    store.upsertProfiles([
      {
        id: 'hermes',
        profileName: 'hermes',
        emailAddress: 'hermes@claw.163.com',
        displayName: 'hermes@claw.163.com',
        imapHost: 'claw.163.com',
        imapPort: 993,
        status: 'READY',
        lastSyncAt: null,
        lastSyncMessage: 'ready',
        unreadCount: 0
      }
    ]);
    store.upsertMessages([fakeMessage('hermes')]);
    const adapter = createRealClawCliAdapter({
      cacheStore: store,
      secretStore,
      imapAdapter: createFakeImapAdapter({ failList: true })
    });

    const result = await adapter.refreshProfile('hermes');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('已保留上次缓存');
    expect(store.listMessages()).toHaveLength(1);
    expect(store.getProfile('hermes')?.status).toBe('ERROR');
    store.close();
  });

  it('deletes a profile from cache and removes the stored credential reference', async () => {
    const store = createSqliteCacheStore(':memory:');
    const secretStore = createMemorySecretStore({ hermes: 'AUTH_CODE' });
    store.upsertProfiles([
      {
        id: 'hermes',
        profileName: 'hermes',
        emailAddress: 'hermes@claw.163.com',
        displayName: 'hermes@claw.163.com',
        imapHost: 'claw.163.com',
        imapPort: 993,
        status: 'READY',
        lastSyncAt: null,
        lastSyncMessage: 'ready',
        unreadCount: 0
      }
    ]);
    store.upsertMessages([fakeMessage('hermes')]);
    store.insertSyncLog({ profileId: 'hermes', status: 'SUCCESS', startedAt: '2026-04-30T10:00:00.000Z', message: 'ok' });
    const adapter = createRealClawCliAdapter({ cacheStore: store, secretStore, imapAdapter: createFakeImapAdapter() });

    const result = await adapter.deleteProfile('hermes');

    expect(result.ok).toBe(true);
    expect(store.listProfiles()).toHaveLength(0);
    expect(store.listMessages()).toHaveLength(0);
    expect(await secretStore.getPassword('hermes')).toBeNull();
    store.close();
  });

  it('exports account metadata without secrets and supports incremental export from lastExportAt', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'clawinbox-export-'));
    const store = createSqliteCacheStore(':memory:');
    const adapter = createRealClawCliAdapter({ cacheStore: store, secretStore: createMemorySecretStore(), imapAdapter: createFakeImapAdapter() });
    store.upsertProfiles([profile('alpha@claw.163.com')]);

    const fullPath = join(tempDir, 'full.json');
    const full = await adapter.exportAccounts({ mode: 'full', outputPath: fullPath });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    store.upsertProfiles([profile('beta@claw.163.com')]);

    const incrementalPath = join(tempDir, 'incremental.json');
    const incremental = await adapter.exportAccounts({ mode: 'incremental', outputPath: incrementalPath });
    const fullJson = await readFile(fullPath, 'utf8');
    const incrementalJson = await readFile(incrementalPath, 'utf8');

    expect(full.ok).toBe(true);
    expect(full.exportedCount).toBe(1);
    expect(incremental.ok).toBe(true);
    expect(incremental.exportedCount).toBe(1);
    expect(JSON.parse(incrementalJson).accounts).toMatchObject([{ email: 'beta@claw.163.com' }]);
    expect(JSON.parse(fullJson).accounts[0]).not.toHaveProperty('profileId');
    expect(`${fullJson}\n${incrementalJson}`).not.toMatch(/AUTH_CODE|authCode|t1\/|ck_live|bodyText|bodyHtml/i);
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('can create an encrypted credential backup without writing plaintext secrets', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'clawinbox-encrypted-backup-'));
    const store = createSqliteCacheStore(':memory:');
    const adapter = createRealClawCliAdapter({
      cacheStore: store,
      secretStore: createMemorySecretStore({ 'alpha@claw.163.com': 'AUTH_CODE_SECRET' }),
      imapAdapter: createFakeImapAdapter()
    });
    store.upsertProfiles([profile('alpha@claw.163.com')]);
    const outputPath = join(tempDir, 'encrypted.json');

    const result = await adapter.exportAccounts({
      mode: 'full',
      outputPath,
      includeCredentials: true,
      backupPassword: 'backup-password'
    });
    const json = await readFile(outputPath, 'utf8');
    const payload = JSON.parse(json);

    expect(result.ok).toBe(true);
    expect(payload.includesCredentials).toBe(true);
    expect(payload.credentialBackup).toMatchObject({
      format: 'encrypted',
      algorithm: 'aes-256-gcm',
      kdf: 'scrypt'
    });
    expect(json).not.toMatch(/AUTH_CODE_SECRET|authCode|t1\/|ck_live|bodyText|bodyHtml/i);
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('can create a plaintext credential backup for local use', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'clawinbox-plaintext-backup-'));
    const store = createSqliteCacheStore(':memory:');
    const adapter = createRealClawCliAdapter({
      cacheStore: store,
      secretStore: createMemorySecretStore({ 'alpha@claw.163.com': 'AUTH_CODE_SECRET' }),
      imapAdapter: createFakeImapAdapter()
    });
    store.upsertProfiles([profile('alpha@claw.163.com')]);
    const outputPath = join(tempDir, 'plaintext.json');

    const result = await adapter.exportAccounts({
      mode: 'full',
      outputPath,
      includeCredentials: true,
      credentialExportMode: 'plaintext'
    });
    const json = await readFile(outputPath, 'utf8');
    const payload = JSON.parse(json);

    expect(result.ok).toBe(true);
    expect(payload.includesCredentials).toBe(true);
    expect(payload.credentialBackup).toMatchObject({
      format: 'plaintext',
      credentials: [{ email: 'alpha@claw.163.com', credential: 'AUTH_CODE_SECRET' }]
    });
    expect(json).not.toMatch(/t1\/|ck_live|bodyText|bodyHtml/i);
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });
});

function createFakeImapAdapter(options: { failList?: boolean; failVerifyEmails?: string[] } = {}) {
  const verifiedPasswords: string[] = [];
  return {
    verifiedPasswords,
    async verifyCredential(credential: { email?: string; password: string }) {
      if (credential.email && options.failVerifyEmails?.includes(credential.email)) {
        throw new Error('AUTHENTICATIONFAILED invalid credentials');
      }
      verifiedPasswords.push(credential.password);
    },
    async listMessages(profile: MailboxProfile) {
      if (options.failList) throw new Error('network failed');
      return [fakeMessage(profile.id)];
    },
    async getMessage(profile: MailboxProfile, _credential: unknown, uid: string, summary?: MailDetail) {
      return { ...(summary ?? fakeMessage(profile.id, uid)), bodyText: 'Hello body' };
    }
  };
}

function fakeMessage(profileId: string, uid = '42'): MailDetail {
  return {
    id: `${profileId}:${uid}`,
    profileId,
    fromName: 'Sender',
    fromAddress: 'sender@example.com',
    subject: 'Hello',
    receivedAt: '2026-04-30T10:00:00.000Z',
    isRead: false,
    hasAttachments: false,
    snippet: 'Hello',
    bodyText: ''
  };
}

function profile(email: string): MailboxProfile {
  return {
    id: email,
    profileName: email.split('@')[0],
    emailAddress: email,
    displayName: email,
    imapHost: 'claw.163.com',
    imapPort: 993,
    status: 'READY',
    lastSyncAt: null,
    lastSyncMessage: 'ready',
    unreadCount: 0
  };
}
