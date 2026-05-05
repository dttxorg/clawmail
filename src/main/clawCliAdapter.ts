import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import type {
  DeleteProfileResult,
  DiagnosticItem,
  ExportAccountsInput,
  ExportAccountsResult,
  InitializeProfileInput,
  InitializeProfilePreviewResult,
  InitializeProfileResult,
  ImportMailboxItemResult,
  MailDetail,
  MailSummary,
  MailboxProfile,
  SyncResult
} from '../shared/types';
import type { CacheStore } from './cacheStore';
import { parseRequiredClawEmailAuthToken, INVALID_AUTH_URL_MESSAGE, redactClawSecrets } from './clawAuthTokenParser';
import {
  CLAW_IMAP_HOST,
  CLAW_IMAP_PORT,
  createHttpClawAuthPayloadFetcher,
  analyzeClawImapPayloadShape,
  parseClawImapCredentials,
  type ClawAuthPayloadFetcher,
  type ClawImapCredential
} from './clawAuthPayloadFetcher';
import { ClawImapCredentialResolver } from './clawImapCredentialResolver';
import type { ResolvedImapCredential } from './clawImapCredentialResolver';
import { ClawImapAdapter } from './imapAdapter';
import { createSystemSecretStore, type SecretStore } from './secretStore';

export interface ClawCliAdapter {
  previewInitializeProfile(input: InitializeProfileInput): Promise<InitializeProfilePreviewResult>;
  initializeProfile(input: InitializeProfileInput): Promise<InitializeProfileResult>;
  listProfiles(): Promise<MailboxProfile[]>;
  listUnifiedInbox(): Promise<MailSummary[]>;
  getMessage(messageId: string): Promise<MailDetail>;
  refreshProfile(profileId: string): Promise<SyncResult>;
  refreshAll(): Promise<SyncResult[]>;
  deleteProfile(profileId: string): Promise<DeleteProfileResult>;
  exportAccounts(input: ExportAccountsInput): Promise<ExportAccountsResult>;
  getDiagnostics(): Promise<DiagnosticItem[]>;
}

interface RealAdapterOptions {
  cacheStore?: CacheStore;
  payloadFetcher?: ClawAuthPayloadFetcher;
  secretStore?: SecretStore;
  imapAdapter?: ImapMailboxAdapter;
}

interface ImapMailboxAdapter {
  verifyCredential(credential: ResolvedImapCredential): Promise<void>;
  listMessages(profile: MailboxProfile, credential: ResolvedImapCredential, limit?: number): Promise<MailDetail[]>;
  getMessage(profile: MailboxProfile, credential: ResolvedImapCredential, uid: string, summary?: MailSummary): Promise<MailDetail>;
}

const now = new Date('2026-04-30T09:30:00.000Z').toISOString();

const mockProfiles: MailboxProfile[] = [
  {
    id: 'profile-ops',
    profileName: 'claw-ops-01',
    emailAddress: 'ops-01@claw.email',
    displayName: '运营收件箱 01',
    imapHost: CLAW_IMAP_HOST,
    imapPort: CLAW_IMAP_PORT,
    status: 'READY',
    lastSyncAt: now,
    lastSyncMessage: '刚刚同步成功',
    unreadCount: 1
  }
];

const mockMessages: MailDetail[] = [
  {
    id: 'mail-001',
    profileId: 'profile-ops',
    fromName: 'ClawEmail Monitor',
    fromAddress: 'monitor@claw.email',
    subject: 'Profile claw-ops-01 今日收信摘要',
    receivedAt: '2026-04-30T09:18:00.000Z',
    isRead: false,
    hasAttachments: false,
    snippet: '过去 1 小时收到 8 封邮件，其中 2 封需要人工确认。',
    bodyText: '过去 1 小时收到 8 封邮件。\n\n这是 mock 数据，用于测试 UI。'
  }
];

export function createMockClawCliAdapter(): ClawCliAdapter {
  return {
    async previewInitializeProfile(input) {
      try {
        parseRequiredClawEmailAuthToken(input.authUrl);
      } catch {
        return { ok: false, accounts: [], hasDuplicates: false, message: INVALID_AUTH_URL_MESSAGE };
      }
      return {
        ok: true,
        accounts: [
          {
            emailAddress: `import-${mockProfiles.length + 1}@claw.163.com`,
            displayName: `新导入邮箱 ${mockProfiles.length + 1}`,
            profileName: `claw-import-${mockProfiles.length + 1}`,
            exists: false
          }
        ],
        hasDuplicates: false,
        message: '检测到 1 个 ClawEmail 邮箱。'
      };
    },
    async initializeProfile(input) {
      try {
        parseRequiredClawEmailAuthToken(input.authUrl);
      } catch {
        return { ok: false, message: INVALID_AUTH_URL_MESSAGE };
      }

      const profile: MailboxProfile = {
        id: `profile-${Date.now()}`,
        profileName: `claw-import-${mockProfiles.length + 1}`,
        emailAddress: `import-${mockProfiles.length + 1}@claw.163.com`,
        displayName: `新导入邮箱 ${mockProfiles.length + 1}`,
        imapHost: CLAW_IMAP_HOST,
        imapPort: CLAW_IMAP_PORT,
        status: 'READY',
        lastSyncAt: new Date().toISOString(),
        lastSyncMessage: 'mock 初始化成功',
        unreadCount: 0
      };
      mockProfiles.unshift(profile);
      return {
        ok: true,
        profile,
        profiles: [profile],
        items: [{ ok: true, emailAddress: profile.emailAddress, displayName: profile.displayName, action: 'added', message: '邮箱初始化成功。' }],
        message: '邮箱初始化成功。'
      };
    },
    async listProfiles() {
      return [...mockProfiles];
    },
    async listUnifiedInbox() {
      return mockMessages.map(({ bodyText: _bodyText, ...summary }) => summary);
    },
    async getMessage(messageId) {
      const message = mockMessages.find((item) => item.id === messageId);
      if (!message) throw new Error('邮件不存在或已从缓存中移除。');
      return message;
    },
    async refreshProfile(profileId) {
      return { ok: true, profileId, syncedAt: new Date().toISOString(), message: 'mock 同步成功。' };
    },
    async refreshAll() {
      return Promise.all(mockProfiles.map((profile) => this.refreshProfile(profile.id)));
    },
    async deleteProfile(profileId) {
      const index = mockProfiles.findIndex((profile) => profile.id === profileId);
      if (index >= 0) mockProfiles.splice(index, 1);
      return { ok: true, profileId, message: '账号已删除。' };
    },
    async exportAccounts(input) {
      const exportedAt = new Date().toISOString();
      return {
        ok: true,
        filePath: input.outputPath ?? join(process.cwd(), buildAccountsExportFileName(new Date(exportedAt))),
        exportedCount: mockProfiles.length,
        since: input.since ?? null,
        lastExportAt: exportedAt,
        message: `已导出 ${mockProfiles.length} 个账号。`
      };
    },
    async getDiagnostics() {
      const checkedAt = new Date().toISOString();
      return [
        { id: 'imap', label: 'IMAP', status: 'OK', message: '当前为 mock IMAP 模式。', checkedAt },
        { id: 'secret-store', label: '系统凭据', status: 'OK', message: 'mock 凭据存储可用。', checkedAt }
      ];
    }
  };
}

export function createRealClawCliAdapter(options: RealAdapterOptions = {}): ClawCliAdapter {
  const cacheStore = options.cacheStore;
  const payloadFetcher = options.payloadFetcher ?? createHttpClawAuthPayloadFetcher();
  const secretStore = options.secretStore ?? createSystemSecretStore();
  const credentialResolver = new ClawImapCredentialResolver(secretStore);
  const imapAdapter = options.imapAdapter ?? new ClawImapAdapter();
  const memoryMessages = new Map<string, MailDetail>();
  const previewCache = new Map<string, { expiresAt: number; credentials: ClawImapCredential[] }>();

  function toProfile(credential: ClawImapCredential): MailboxProfile {
    const existingProfile = cachedProfiles().find((profile) => profile.emailAddress.toLowerCase() === credential.email.toLowerCase());
    return {
      id: existingProfile?.id ?? credential.profileId,
      profileName: credential.profileName,
      emailAddress: credential.email,
      displayName: credential.displayName,
      imapHost: credential.imapHost,
      imapPort: credential.imapPort,
      status: 'READY',
      lastSyncAt: null,
      lastSyncMessage: 'IMAP 授权成功，等待首次同步。',
      unreadCount: 0
    };
  }

  function cachedProfiles(): MailboxProfile[] {
    return cacheStore?.listProfiles() ?? [];
  }

  function cachedMessages(): MailSummary[] {
    return cacheStore?.listMessages() ?? [];
  }

  async function resolveCredentialsForAuthUrl(authUrl: string): Promise<{ token: string; credentials: ClawImapCredential[] }> {
    const token = parseRequiredClawEmailAuthToken(authUrl);
    const cacheKey = hashSecret(token);
    const cached = previewCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { token, credentials: cached.credentials };
    }

    const payload = await payloadFetcher.fetch(token);
    const credentials = parseClawImapCredentials(payload);
    if (credentials.length === 0) {
      throw new Error(`当前授权口令是 WS/API-key 模式，不包含 IMAP 密码。请在 ClawEmail 后台复制“为 Hermes 安装”的命令。脱敏结构：${JSON.stringify(analyzeClawImapPayloadShape(payload))}`);
    }

    previewCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60 * 1000, credentials });
    return { token, credentials };
  }

  function previewAccounts(credentials: ClawImapCredential[]): InitializeProfilePreviewResult['accounts'] {
    const profiles = cachedProfiles();
    return credentials.map((credential) => ({
      emailAddress: credential.email,
      displayName: credential.displayName,
      profileName: credential.profileName,
      exists: profiles.some((profile) => profile.emailAddress.toLowerCase() === credential.email.toLowerCase())
    }));
  }

  async function previewInitializeProfile(input: InitializeProfileInput): Promise<InitializeProfilePreviewResult> {
    try {
      const { credentials } = await resolveCredentialsForAuthUrl(input.authUrl);
      const accounts = previewAccounts(credentials);
      return {
        ok: true,
        accounts,
        hasDuplicates: accounts.some((account) => account.exists),
        message: `检测到 ${accounts.length} 个 ClawEmail 邮箱：${accounts.map((account) => account.emailAddress).join('、')}`
      };
    } catch (error) {
      return { ok: false, accounts: [], hasDuplicates: false, message: toChineseError('预览导入', error) };
    }
  }

  async function initializeProfile(input: InitializeProfileInput): Promise<InitializeProfileResult> {
    try {
      const { token, credentials } = await resolveCredentialsForAuthUrl(input.authUrl);
      const duplicateAction = input.duplicateAction ?? 'update';
      if (duplicateAction === 'cancel') {
        return { ok: false, items: [], message: '已取消导入。' };
      }

      const profiles: MailboxProfile[] = [];
      const items: ImportMailboxItemResult[] = [];
      for (const credential of credentials) {
        const profile = toProfile(credential);
        const exists = cachedProfiles().some((item) => item.emailAddress.toLowerCase() === credential.email.toLowerCase());
        if (exists && duplicateAction === 'skip') {
          items.push({
            ok: true,
            emailAddress: profile.emailAddress,
            displayName: profile.displayName,
            action: 'skipped',
            message: '邮箱已存在，已跳过。'
          });
          continue;
        }

        try {
          await imapAdapter.verifyCredential({
            profileId: profile.id,
            email: credential.email,
            password: credential.authCode,
            host: credential.imapHost,
            port: credential.imapPort,
            secure: credential.imapSecure
          });
          await secretStore.setPassword(profile.id, credential.authCode);
          profiles.push(profile);
          items.push({
            ok: true,
            emailAddress: profile.emailAddress,
            displayName: profile.displayName,
            action: exists ? 'updated' : 'added',
            message: exists ? '邮箱已存在，凭据已更新。' : '邮箱导入成功。'
          });
        } catch (error) {
          items.push({
            ok: false,
            emailAddress: profile.emailAddress,
            displayName: profile.displayName,
            action: 'failed',
            message: toChineseError('导入该邮箱', error)
          });
        }
      }

      cacheStore?.upsertProfiles(profiles);
      previewCache.delete(hashSecret(token));
      const successCount = items.filter((item) => item.ok && item.action !== 'skipped').length;
      const skippedCount = items.filter((item) => item.action === 'skipped').length;
      const failedCount = items.filter((item) => !item.ok).length;
      return {
        ok: failedCount === 0 && (successCount > 0 || skippedCount > 0),
        profile: profiles[0],
        profiles,
        items,
        message: `导入完成：${successCount} 个成功，${skippedCount} 个跳过，${failedCount} 个失败。`
      };
    } catch (error) {
      return { ok: false, message: toChineseError('初始化邮箱', error) };
    }
  }

  async function refreshProfile(profileId: string): Promise<SyncResult> {
    const profile = cachedProfiles().find((item) => item.id === profileId || item.profileName === profileId);
    const syncedAt = new Date().toISOString();
    if (!profile) {
      return { ok: false, profileId, syncedAt, message: '未找到对应 ClawEmail 邮箱。' };
    }

    cacheStore?.updateProfileSync(profile.id, 'SYNCING', '同步中，请稍候。');
    cacheStore?.insertSyncLog({ profileId: profile.id, status: 'SYNCING', startedAt: syncedAt, message: '同步中，请稍候。' });

    try {
      const credential = await credentialResolver.resolve(profile);
      const messages = await imapAdapter.listMessages(profile, credential);
      for (const message of messages) memoryMessages.set(message.id, message);
      cacheStore?.upsertMessages(messages);

      const finishedAt = new Date().toISOString();
      const unreadCount = messages.filter((message) => !message.isRead).length;
      const message = `同步成功，读取到 ${messages.length} 封邮件。`;
      cacheStore?.updateProfileSync(profile.id, 'READY', message, finishedAt, unreadCount);
      cacheStore?.insertSyncLog({ profileId: profile.id, status: 'SUCCESS', startedAt: syncedAt, finishedAt, message });
      return { ok: true, profileId: profile.id, syncedAt: finishedAt, message };
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const message = `${toChineseError('刷新邮件列表', error)} 已保留上次缓存。`;
      cacheStore?.updateProfileSync(profile.id, 'ERROR', message, finishedAt);
      cacheStore?.insertSyncLog({ profileId: profile.id, status: 'FAILED', startedAt: syncedAt, finishedAt, message });
      return { ok: false, profileId: profile.id, syncedAt: finishedAt, message };
    }
  }

  return {
    previewInitializeProfile,
    initializeProfile,
    async listProfiles() {
      return cachedProfiles();
    },
    async listUnifiedInbox() {
      return cachedMessages();
    },
    async getMessage(messageId) {
      const cached = memoryMessages.get(messageId) ?? cacheStore?.getMessage(messageId) ?? null;
      if (cached?.bodyText) return cached;

      const profileId = cached?.profileId ?? parseProfileIdFromMessageId(messageId);
      const uid = parseUidFromMessageId(messageId);
      const profile = cachedProfiles().find((item) => item.id === profileId);
      if (!profile || !uid) throw new Error('没有可读取的 ClawEmail 邮箱或邮件编号。');

      const credential = await credentialResolver.resolve(profile);
      const detail = await imapAdapter.getMessage(profile, credential, uid, cached ?? undefined);
      memoryMessages.set(detail.id, detail);
      cacheStore?.upsertMessages([detail]);
      return detail;
    },
    refreshProfile,
    async refreshAll() {
      const results: SyncResult[] = [];
      for (const profile of cachedProfiles()) {
        results.push(await refreshProfile(profile.id));
      }
      return results;
    },
    async deleteProfile(profileId) {
      const profile = cacheStore?.getProfile(profileId);
      if (!profile) return { ok: false, profileId, message: '删除失败：未找到对应账号。' };

      try {
        await secretStore.deletePassword(profile.id);
        cacheStore?.deleteProfile(profile.id);
        for (const messageId of [...memoryMessages.keys()]) {
          if (messageId.startsWith(`${profile.id}:`)) memoryMessages.delete(messageId);
        }
        return { ok: true, profileId: profile.id, message: `已删除账号 ${profile.emailAddress}。` };
      } catch (error) {
        return { ok: false, profileId: profile.id, message: toChineseError('删除账号', error) };
      }
    },
    async exportAccounts(input) {
      if (!cacheStore) {
        return { ok: false, exportedCount: 0, message: '导出失败：本地缓存不可用。' };
      }

      try {
        const since = input.mode === 'incremental' ? input.since ?? cacheStore.getSetting('lastExportAt') : null;
        const exportableProfiles = cacheStore.listExportableProfiles(since);
        const accounts = exportableProfiles.map(({ profileId: _profileId, ...account }) => account);
        const exportedAt = new Date().toISOString();
        const outputPath = input.outputPath ?? join(process.cwd(), buildAccountsExportFileName(new Date(exportedAt)));
        const credentialBackup = input.includeCredentials
          ? input.credentialExportMode === 'plaintext'
            ? await buildPlaintextCredentialBackup(exportableProfiles, secretStore)
            : await buildEncryptedCredentialBackup(exportableProfiles, secretStore, input.backupPassword ?? '')
          : null;
        const payload = {
          schemaVersion: 1,
          exportedAt,
          mode: input.mode,
          since: since ?? null,
          includesCredentials: Boolean(credentialBackup),
          accounts,
          ...(credentialBackup ? { credentialBackup } : {})
        };

        await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        cacheStore.setSetting('lastExportAt', exportedAt);
        return {
          ok: true,
          filePath: outputPath,
          exportedCount: accounts.length,
          since: since ?? null,
          lastExportAt: exportedAt,
          message: `已导出 ${accounts.length} 个账号。`
        };
      } catch (error) {
        return { ok: false, exportedCount: 0, message: toChineseError('导出账号', error) };
      }
    },
    async getDiagnostics() {
      const checkedAt = new Date().toISOString();
      const profiles = cachedProfiles();
      return [
        {
          id: 'imap',
          label: 'ClawEmail IMAP',
          status: 'OK',
          message: `使用 ${CLAW_IMAP_HOST}:${CLAW_IMAP_PORT} 安全 IMAP 连接，不调用 OpenClaw / Hermes / mail-cli。`,
          checkedAt
        },
        {
          id: 'secret-store',
          label: '系统凭据',
          status: 'OK',
          message: 'authCode 仅写入系统凭据存储，SQLite 不保存 authCode。',
          checkedAt
        },
        {
          id: 'profiles',
          label: '本地邮箱缓存',
          status: profiles.length > 0 ? 'OK' : 'WARN',
          message: `当前本地缓存 ${profiles.length} 个 ClawEmail IMAP 邮箱。`,
          checkedAt
        }
      ] satisfies DiagnosticItem[];
    }
  };
}

async function buildPlaintextCredentialBackup(
  profiles: Array<{ profileId: string; email: string }>,
  secretStore: SecretStore
): Promise<{
  format: 'plaintext';
  warning: string;
  credentials: Array<{ email: string; credential: string }>;
}> {
  const credentials = [];
  for (const profile of profiles) {
    const credential = await secretStore.getPassword(profile.profileId);
    if (credential) credentials.push({ email: profile.email, credential });
  }

  return {
    format: 'plaintext',
    warning: 'This backup contains plaintext ClawEmail IMAP credentials. Keep it private.',
    credentials
  };
}

async function buildEncryptedCredentialBackup(
  profiles: Array<{ profileId: string; email: string }>,
  secretStore: SecretStore,
  backupPassword: string
): Promise<{
  format: 'encrypted';
  algorithm: 'aes-256-gcm';
  kdf: 'scrypt';
  salt: string;
  iv: string;
  tag: string;
  data: string;
}> {
  if (backupPassword.length < 8) {
    throw new Error('加密备份失败：备份密码至少需要 8 位。');
  }

  const credentials = [];
  for (const profile of profiles) {
    const password = await secretStore.getPassword(profile.profileId);
    if (password) {
      credentials.push({ email: profile.email, credential: password });
    }
  }

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(backupPassword, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify({ credentials }), 'utf8'),
    cipher.final()
  ]);

  return {
    format: 'encrypted',
    algorithm: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  };
}

export function buildAccountsExportFileName(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `ClawInbox-accounts-export-${stamp}.json`;
}

function parseProfileIdFromMessageId(messageId: string): string {
  return messageId.split(':')[0] ?? '';
}

function parseUidFromMessageId(messageId: string): string {
  return messageId.split(':').slice(1).join(':');
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toChineseError(action: string, error: unknown): string {
  const message = redactClawSecrets(error instanceof Error ? error.message : String(error));
  if (/WS\/API-key|API-key 模式|不包含 IMAP 密码/i.test(message)) {
    return `${action}失败：当前授权是 WS/API-key 模式，不包含 IMAP 密码。请在 ClawEmail 后台复制“为 Hermes 安装”的命令。`;
  }
  if (/授权链接无效|已过期|HTTP 4\d\d|not found|gone/i.test(message)) {
    return `${action}失败：Hermes 授权口令无效或已过期，请重新生成 ClawEmail Hermes 安装命令。`;
  }
  if (/authentication|login|invalid credentials|AUTHENTICATIONFAILED|password/i.test(message)) {
    return `${action}失败：IMAP 登录失败，请重新生成 Hermes 授权命令后添加邮箱。`;
  }
  if (/keychain|credential store|secret|security|secret-tool|CredWrite|凭据存储|安全凭据/i.test(message)) {
    return `${action}失败：系统 Keychain / Credential Store 写入失败，请检查系统凭据权限后重试。`;
  }
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) {
    return `${action}超时，请检查网络后重试。`;
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|network/i.test(message)) {
    return `${action}失败：无法连接 ClawEmail IMAP 服务，请检查网络。`;
  }
  return message ? `${action}失败：${message}` : `${action}失败，请稍后重试。`;
}
