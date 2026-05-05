import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { MailDetail, MailSummary, MailboxProfile } from '../shared/types';
import type { ResolvedImapCredential } from './clawImapCredentialResolver';

export interface ImapClientLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close?(): void;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  status(path: string, query: { unseen?: boolean; messages?: boolean }): Promise<{ unseen?: number; messages?: number }>;
  search(query: { all?: boolean }, options: { uid?: boolean }): Promise<number[] | false>;
  fetchAll(range: string | number[], query: unknown, options?: { uid?: boolean }): Promise<FetchMessageObject[]>;
  fetchOne(sequence: string, query: unknown, options?: { uid?: boolean }): Promise<FetchMessageObject | false>;
}

export type ImapClientFactory = (credential: ResolvedImapCredential) => ImapClientLike;

const INBOX = 'INBOX';

export function createDefaultImapClientFactory(): ImapClientFactory {
  return (credential) =>
    new ImapFlow({
      host: credential.host,
      port: credential.port,
      secure: credential.secure,
      auth: {
        user: credential.email,
        pass: credential.password
      },
      logger: false,
      connectionTimeout: 30_000,
      greetingTimeout: 20_000,
      socketTimeout: 60_000,
      clientInfo: {
        name: 'ClawInbox'
      }
    }) as ImapClientLike;
}

export class ClawImapAdapter {
  constructor(private readonly clientFactory: ImapClientFactory = createDefaultImapClientFactory()) {}

  async verifyCredential(credential: ResolvedImapCredential): Promise<void> {
    await this.withClient(credential, async () => undefined);
  }

  async listMessages(profile: MailboxProfile, credential: ResolvedImapCredential, limit = 50): Promise<MailDetail[]> {
    return this.withInbox(credential, async (client) => {
      const uids = await client.search({ all: true }, { uid: true });
      if (!uids || uids.length === 0) return [];

      const latestUids = [...uids].sort((a, b) => b - a).slice(0, limit);
      const rows = await client.fetchAll(latestUids, { uid: true, flags: true, envelope: true, internalDate: true, bodyStructure: true }, { uid: true });

      return rows
        .map((row) => messageFromFetch(row, profile))
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    });
  }

  async getMessage(profile: MailboxProfile, credential: ResolvedImapCredential, uid: string, summary?: MailSummary): Promise<MailDetail> {
    return this.withInbox(credential, async (client) => {
      const row = await client.fetchOne(uid, { uid: true, flags: true, envelope: true, internalDate: true, bodyStructure: true, source: true }, { uid: true });
      if (!row) {
        throw new Error('邮件不存在或已从服务器移除。');
      }

      const base = { ...messageFromFetch(row, profile), ...summary };
      if (!row.source) return { ...base, bodyText: base.snippet || '未读取到邮件正文。' };

      const parsed = await simpleParser(row.source);
      const html = parsed.html ? String(parsed.html).trim() : '';
      const text = html ? stripHtml(html).trim() : parsed.text?.trim() || '';
      return {
        ...base,
        fromName: parsed.from?.value?.[0]?.name || base.fromName,
        fromAddress: parsed.from?.value?.[0]?.address || base.fromAddress,
        subject: parsed.subject || base.subject,
        receivedAt: (parsed.date ?? new Date(base.receivedAt)).toISOString(),
        hasAttachments: parsed.attachments.length > 0 || base.hasAttachments,
        snippet: makeSnippet(text || base.snippet),
        bodyText: text || base.bodyText || '未读取到邮件正文。',
        bodyHtml: html || base.bodyHtml
      };
    });
  }

  async getUnreadCount(credential: ResolvedImapCredential): Promise<number> {
    return this.withClient(credential, async (client) => {
      const status = await client.status(INBOX, { unseen: true, messages: true });
      return status.unseen ?? 0;
    });
  }

  private async withInbox<T>(credential: ResolvedImapCredential, callback: (client: ImapClientLike) => Promise<T>): Promise<T> {
    return this.withClient(credential, async (client) => {
      const lock = await client.getMailboxLock(INBOX);
      try {
        return await callback(client);
      } finally {
        lock.release();
      }
    });
  }

  private async withClient<T>(credential: ResolvedImapCredential, callback: (client: ImapClientLike) => Promise<T>): Promise<T> {
    const client = this.clientFactory(credential);
    try {
      await client.connect();
      return await callback(client);
    } finally {
      try {
        await client.logout();
      } catch {
        client.close?.();
      }
    }
  }
}

function messageFromFetch(row: FetchMessageObject, profile: MailboxProfile): MailDetail {
  const from = row.envelope?.from?.[0];
  const receivedAt = toIsoDate(row.internalDate ?? row.envelope?.date);
  const subject = row.envelope?.subject || '(无主题)';
  const fromAddress = from?.address || '未知发件人';
  const fromName = from?.name || fromAddress;
  const id = `${profile.id}:${row.uid}`;

  return {
    id,
    profileId: profile.id,
    fromName,
    fromAddress,
    subject,
    receivedAt,
    isRead: row.flags?.has('\\Seen') ?? false,
    hasAttachments: hasAttachment(row.bodyStructure),
    snippet: subject,
    bodyText: ''
  };
}

function hasAttachment(node: FetchMessageObject['bodyStructure']): boolean {
  if (!node) return false;
  if (node.disposition?.toLowerCase() === 'attachment') return true;
  return node.childNodes?.some(hasAttachment) ?? false;
}

function toIsoDate(value: Date | string | undefined): string {
  if (!value) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function makeSnippet(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
