import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { createRealClawCliAdapter } from '../main/clawCliAdapter';
import { createSqliteCacheStore } from '../main/cacheStore';
import type { MailSummary, MailboxProfile } from '../shared/types';
import { createSqliteAccessKeyStore, type AccessKeyStore, type GuestAccessKeyResult } from './accessKeyStore';
import { createEncryptedFileSecretStore } from './encryptedFileSecretStore';
import { RefreshManager } from './refreshManager';

interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  databasePath: string;
  secretFilePath: string;
  staticDir: string;
  adminUsername: string;
  adminPassword: string;
  masterKey: string;
  refreshCooldownMs: number;
}

interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  method: string;
}

type JsonValue = unknown;

export function loadServerConfig(env = process.env): ServerConfig {
  const dataDir = env.CLAWMAIL_DATA_DIR || '/data';
  const port = Number(env.PORT || env.CLAWMAIL_PORT || 8080);
  const isProduction = env.NODE_ENV === 'production';
  const adminPassword = env.CLAWMAIL_ADMIN_PASSWORD || '';
  const masterKey = env.CLAWMAIL_MASTER_KEY || '';

  if (isProduction && !adminPassword) {
    throw new Error('生产环境必须设置 CLAWMAIL_ADMIN_PASSWORD。');
  }
  if (isProduction && !masterKey) {
    throw new Error('生产环境必须设置 CLAWMAIL_MASTER_KEY。');
  }

  return {
    port: Number.isFinite(port) ? port : 8080,
    host: env.HOST || '0.0.0.0',
    dataDir,
    databasePath: env.CLAWMAIL_DATABASE_PATH || join(dataDir, 'clawmail.sqlite'),
    secretFilePath: env.CLAWMAIL_SECRET_FILE || join(dataDir, 'imap-secrets.json'),
    staticDir: env.CLAWMAIL_STATIC_DIR || join(process.cwd(), 'dist/client'),
    adminUsername: env.CLAWMAIL_ADMIN_USERNAME || 'admin',
    adminPassword: adminPassword || 'admin',
    masterKey: masterKey || 'development-master-key',
    refreshCooldownMs: Number(env.CLAWMAIL_REFRESH_COOLDOWN_MS || 60_000)
  };
}

export async function createClawMailServer(config = loadServerConfig()) {
  await mkdir(config.dataDir, { recursive: true });

  const cacheStore = createSqliteCacheStore(config.databasePath);
  const accessKeyStore = createSqliteAccessKeyStore(config.databasePath, config.masterKey);
  const secretStore = createEncryptedFileSecretStore(config.secretFilePath, config.masterKey);
  const adapter = createRealClawCliAdapter({ cacheStore, secretStore });
  const refreshManager = new RefreshManager(adapter, config.refreshCooldownMs);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const ctx: RequestContext = {
      req,
      res,
      url,
      path: normalizePath(url.pathname),
      method: req.method || 'GET'
    };

    try {
      if (ctx.path.startsWith('/api/')) {
        await routeApi(ctx, {
          config,
          adapter,
          accessKeyStore,
          refreshManager
        });
        return;
      }

      serveStatic(ctx, config.staticDir);
    } catch (error) {
      const message = error instanceof HttpError ? error.message : '服务暂时不可用。';
      writeJson(res, error instanceof HttpError ? error.status : 500, {
        error: {
          code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR',
          message
        }
      });
    }
  });

  server.on('close', () => {
    cacheStore.close();
    accessKeyStore.close();
  });

  return server;
}

async function routeApi(
  ctx: RequestContext,
  dependencies: {
    config: ServerConfig;
    adapter: ReturnType<typeof createRealClawCliAdapter>;
    accessKeyStore: AccessKeyStore;
    refreshManager: RefreshManager;
  }
): Promise<void> {
  const { adapter, accessKeyStore, config, refreshManager } = dependencies;

  if (ctx.method === 'GET' && ctx.path === '/api/health') {
    writeJson(ctx.res, 200, { ok: true });
    return;
  }

  if (ctx.path.startsWith('/api/admin/')) {
    requireAdmin(ctx, config);

    if (ctx.method === 'GET' && ctx.path === '/api/admin/mailboxes') {
      const profiles = await adapter.listProfiles();
      writeJson(ctx.res, 200, {
        profiles: profiles.map((profile) => withAccessKeyMetadata(profile, accessKeyStore))
      });
      return;
    }

    if (ctx.method === 'GET' && ctx.path === '/api/admin/messages') {
      const profileId = ctx.url.searchParams.get('profileId');
      const messages = await adapter.listUnifiedInbox();
      writeJson(ctx.res, 200, {
        messages: profileId && profileId !== 'all' ? messages.filter((message) => message.profileId === profileId) : messages
      });
      return;
    }

    const adminMessageMatch = ctx.path.match(/^\/api\/admin\/messages\/(.+)$/);
    if (ctx.method === 'GET' && adminMessageMatch) {
      const messageId = decodeURIComponent(adminMessageMatch[1]);
      writeJson(ctx.res, 200, await adapter.getMessage(messageId));
      return;
    }

    if (ctx.method === 'POST' && ctx.path === '/api/admin/mailboxes') {
      const body = await readJsonBody(ctx.req);
      const authUrl = typeof body.authUrl === 'string' ? body.authUrl.trim() : '';
      if (!authUrl) throw new HttpError(422, 'VALIDATION_ERROR', '请填写 ClawEmail Hermes 安装命令或 auth-url。');

      const result = await adapter.initializeProfile({ authUrl });
      const guestAccessKeys: GuestAccessKeyResult[] = [];
      for (const profile of result.profiles ?? (result.profile ? [result.profile] : [])) {
        const accessKey = accessKeyStore.ensureAccessKey(profile.id);
        if ('key' in accessKey) guestAccessKeys.push({ ...accessKey, profileId: profile.id });
      }

      writeJson(ctx.res, result.ok ? 201 : 422, { ...result, guestAccessKeys });
      return;
    }

    const mailboxMatch = ctx.path.match(/^\/api\/admin\/mailboxes\/([^/]+)(?:\/([^/]+))?$/);
    if (mailboxMatch) {
      const profileId = decodeURIComponent(mailboxMatch[1]);
      const action = mailboxMatch[2] || '';

      if (ctx.method === 'POST' && action === 'refresh') {
        const refresh = await refreshManager.refreshProfile(profileId, { force: true });
        writeJson(ctx.res, refresh.result.ok ? 200 : 502, refresh);
        return;
      }

      if (ctx.method === 'POST' && action === 'guest-key') {
        const profile = (await adapter.listProfiles()).find((item) => item.id === profileId);
        if (!profile) throw new HttpError(404, 'NOT_FOUND', '未找到对应邮箱。');
        writeJson(ctx.res, 201, accessKeyStore.rotateAccessKey(profile.id));
        return;
      }

      if (ctx.method === 'GET' && action === 'guest-key') {
        const profile = (await adapter.listProfiles()).find((item) => item.id === profileId);
        if (!profile) throw new HttpError(404, 'NOT_FOUND', '未找到对应邮箱。');
        writeJson(ctx.res, 200, accessKeyStore.getAccessKey(profile.id));
        return;
      }

      if (ctx.method === 'DELETE' && !action) {
        const result = await adapter.deleteProfile(profileId);
        writeJson(ctx.res, result.ok ? 200 : 404, result);
        return;
      }
    }
  }

  if (ctx.path.startsWith('/api/guest/')) {
    if (ctx.method === 'POST' && ctx.path === '/api/guest/session') {
      const body = await readJsonBody(ctx.req);
      const key = typeof body.accessKey === 'string' ? body.accessKey.trim() : '';
      const profileId = accessKeyStore.verifyAccessKey(key);
      if (!profileId) throw new HttpError(401, 'INVALID_GUEST_KEY', '密钥无效或已被重置。');

      const refresh = await refreshManager.refreshProfile(profileId);
      const payload = await buildGuestMailbox(adapter, profileId);
      writeJson(ctx.res, 200, { ...payload, refresh });
      return;
    }

    const profileId = requireGuestProfileId(ctx, accessKeyStore);
    if (ctx.method === 'GET' && ctx.path === '/api/guest/messages') {
      writeJson(ctx.res, 200, await buildGuestMailbox(adapter, profileId));
      return;
    }

    if (ctx.method === 'POST' && ctx.path === '/api/guest/refresh') {
      const refresh = await refreshManager.refreshProfile(profileId);
      const payload = await buildGuestMailbox(adapter, profileId);
      writeJson(ctx.res, 200, { ...payload, refresh });
      return;
    }

    const messageMatch = ctx.path.match(/^\/api\/guest\/messages\/(.+)$/);
    if (ctx.method === 'GET' && messageMatch) {
      const messageId = decodeURIComponent(messageMatch[1]);
      const messages = await adapter.listUnifiedInbox();
      const summary = messages.find((message) => message.id === messageId && message.profileId === profileId);
      if (!summary) throw new HttpError(404, 'NOT_FOUND', '未找到对应邮件。');
      writeJson(ctx.res, 200, await adapter.getMessage(summary.id));
      return;
    }
  }

  throw new HttpError(404, 'NOT_FOUND', '接口不存在。');
}

async function buildGuestMailbox(adapter: ReturnType<typeof createRealClawCliAdapter>, profileId: string): Promise<{
  profile: MailboxProfile;
  messages: MailSummary[];
}> {
  const profiles = await adapter.listProfiles();
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) throw new HttpError(404, 'NOT_FOUND', '未找到对应邮箱。');
  const messages = (await adapter.listUnifiedInbox()).filter((message) => message.profileId === profile.id);
  return { profile, messages };
}

function withAccessKeyMetadata(profile: MailboxProfile, accessKeyStore: AccessKeyStore) {
  const metadata = accessKeyStore.listAccessKeys([profile.id])[0] ?? null;
  return {
    ...profile,
    guestAccessKey: metadata
      ? {
          createdAt: metadata.createdAt,
          lastUsedAt: metadata.lastUsedAt
        }
      : null
  };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求内容过大。');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};

  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Invalid JSON object');
    }
    return body as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', '请求 JSON 格式无效。');
  }
}

function requireAdmin(ctx: RequestContext, config: ServerConfig): void {
  const header = ctx.req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Basic' || !token) {
    writeAuthRequired(ctx.res);
    throw new ResponseAlreadySent();
  }

  const decoded = Buffer.from(token, 'base64').toString('utf8');
  const splitAt = decoded.indexOf(':');
  const username = splitAt >= 0 ? decoded.slice(0, splitAt) : '';
  const password = splitAt >= 0 ? decoded.slice(splitAt + 1) : '';
  if (username !== config.adminUsername || !safeEqual(password, config.adminPassword)) {
    writeAuthRequired(ctx.res);
    throw new ResponseAlreadySent();
  }
}

function requireGuestProfileId(ctx: RequestContext, accessKeyStore: AccessKeyStore): string {
  const key = String(ctx.req.headers['x-guest-key'] || '').trim();
  const profileId = accessKeyStore.verifyAccessKey(key);
  if (!profileId) throw new HttpError(401, 'INVALID_GUEST_KEY', '密钥无效或已被重置。');
  return profileId;
}

function writeAuthRequired(res: ServerResponse): void {
  res.writeHead(401, {
    'content-type': 'application/json; charset=utf-8',
    'www-authenticate': 'Basic realm="ClawMail Admin"'
  });
  res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: '请先登录管理员账号。' } }));
}

function safeEqual(input: string, expected: string): boolean {
  const inputHash = Buffer.from(input);
  const expectedHash = Buffer.from(expected);
  return inputHash.length === expectedHash.length && timingSafeEqual(inputHash, expectedHash);
}

function serveStatic(ctx: RequestContext, staticDir: string): void {
  const requestedPath = ctx.path === '/' ? '/index.html' : ctx.path;
  const candidate = normalize(join(staticDir, requestedPath));
  const root = normalize(staticDir);
  const filePath = candidate.startsWith(root) && existsSync(candidate) ? candidate : join(staticDir, 'index.html');

  if (!existsSync(filePath)) {
    writeJson(ctx.res, 404, { error: { code: 'NOT_FOUND', message: '前端文件不存在，请先构建项目。' } });
    return;
  }

  ctx.res.writeHead(200, { 'content-type': mimeType(filePath) });
  createReadStream(filePath).pipe(ctx.res);
}

function writeJson(res: ServerResponse, status: number, value: JsonValue): void {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(value));
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\/{2,}/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}

function mimeType(filePath: string): string {
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon'
  };
  return types[extname(filePath)] || 'application/octet-stream';
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

class ResponseAlreadySent extends Error {}
