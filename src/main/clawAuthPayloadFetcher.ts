import { createHash } from 'node:crypto';

export interface ClawImapCredential {
  profileId: string;
  profileName: string;
  email: string;
  displayName: string;
  authCode: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
}

export interface ClawAuthPayloadFetcher {
  fetch(token: string): Promise<string>;
}

export interface ClawImapPayloadShape {
  format: 'json' | 'colon-lines' | 'text' | 'empty';
  nonEmptyLineCount: number;
  colonLineCount: number;
  accountLineCount: number;
  accountLinesWithAuthCode: number;
  hasDoubleUnderscoreApiKey: boolean;
  hasEmail: boolean;
  jsonKeys: string[];
}

export const CLAW_IMAP_HOST = 'claw.163.com';
export const CLAW_IMAP_PORT = 993;

export function createHttpClawAuthPayloadFetcher(): ClawAuthPayloadFetcher {
  return {
    async fetch(token) {
      const url = new URL(`https://u.163.com/${token}`);
      url.searchParams.set('client', 'hermes');
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`获取授权信息失败（HTTP ${response.status}），请重新生成 Hermes 安装命令。`);
      }
      const text = (await response.text()).trim();
      if (!text || /<html|<!doctype/i.test(text)) {
        throw new Error('授权链接无效或已过期，请重新生成 Hermes 安装命令。');
      }
      return text;
    }
  };
}

export function parseClawImapCredentials(payload: string): ClawImapCredential[] {
  const json = tryParseJson(payload);
  const fromJson = parseJsonCredentials(json);
  if (fromJson.length > 0) return fromJson;

  const accounts: ClawImapCredential[] = [];
  for (const rawLine of payload.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('__')) continue;

    const first = line.indexOf(':');
    const second = line.indexOf(':', first + 1);
    if (first < 0 || second < 0) continue;

    const name = line.slice(0, first).trim();
    const accountId = line.slice(first + 1, second).trim();
    const authCode = line.slice(second + 1).trim();
    if (!name || !accountId || !authCode) continue;

    const email = looksLikeEmail(name) ? name : `${name}@claw.163.com`;
    accounts.push(toCredential(accountId, email, email, authCode));
  }

  return accounts;
}

export function analyzeClawImapPayloadShape(payload: string): ClawImapPayloadShape {
  const trimmed = payload.trim();
  const json = tryParseJson(payload);
  const lines = payload
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const colonLines = lines.filter((line) => line.includes(':'));
  const accountLines = colonLines.filter((line) => !line.startsWith('__'));
  const accountLinesWithAuthCode = accountLines.filter((line) => {
    const first = line.indexOf(':');
    const second = line.indexOf(':', first + 1);
    return second >= 0 && line.slice(second + 1).trim().length > 0;
  });

  return {
    format: !trimmed ? 'empty' : json ? 'json' : colonLines.length > 0 ? 'colon-lines' : 'text',
    nonEmptyLineCount: lines.length,
    colonLineCount: colonLines.length,
    accountLineCount: accountLines.length,
    accountLinesWithAuthCode: accountLinesWithAuthCode.length,
    hasDoubleUnderscoreApiKey: payload.includes('__apikey__'),
    hasEmail: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(payload),
    jsonKeys: json && !Array.isArray(json) && typeof json === 'object' ? Object.keys(json as Record<string, unknown>).map(safeJsonKey) : []
  };
}

function parseJsonCredentials(value: unknown): ClawImapCredential[] {
  if (Array.isArray(value)) return value.flatMap(parseJsonCredentials);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;

  const nested = ['accounts', 'profiles', 'mailboxes', 'items', 'data', 'result']
    .flatMap((key) => parseJsonCredentials(record[key]))
    .filter(Boolean);
  if (nested.length > 0) return nested;

  const email = readString(record, ['email', 'emailAddress', 'user', 'mailbox']);
  const profileName = readString(record, ['profileId', 'profile', 'accountId', 'account_id', 'id', 'name']);
  const authCode = readString(record, ['authCode', 'auth_code', 'password', 'pass', 'imapPassword']);
  if (!email || !profileName || !authCode) return [];

  const displayName = readString(record, ['displayName', 'display', 'label', 'name'], email);
  return [toCredential(profileName, email, displayName, authCode)];
}

function toCredential(profileName: string, email: string, displayName: string, authCode: string): ClawImapCredential {
  const normalizedEmail = email.trim().toLowerCase();
  return {
    profileId: normalizedEmail,
    profileName: safeProfileId(profileName || normalizedEmail),
    email: normalizedEmail,
    displayName,
    authCode,
    imapHost: CLAW_IMAP_HOST,
    imapPort: CLAW_IMAP_PORT,
    imapSecure: true
  };
}

function safeProfileId(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (cleaned) return cleaned;
  return `claw-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

function readString(record: Record<string, unknown>, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return fallback;
}

function tryParseJson(output: string): unknown | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function looksLikeEmail(value: string): boolean {
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(value);
}

function safeJsonKey(key: string): string {
  if (/^(accounts?|profiles?|mailboxes?|items|data|result|email|user|accountId|account_id|profile|authCode|auth_code|password|pass)$/i.test(key)) {
    return key;
  }
  return `[field:${key.length}]`;
}
