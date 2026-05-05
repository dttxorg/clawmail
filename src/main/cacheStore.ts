import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Database as DatabaseConnection } from 'better-sqlite3';
import type { ExportAccountRecord, MailDetail, MailSummary, MailboxProfile, ProfileStatus } from '../shared/types';

type RowValue = string | number | null;

interface ProfileRow {
  id: string;
  profile_name: string;
  email_address: string;
  display_name: string;
  imap_host?: string | null;
  imap_port?: number | null;
  status: ProfileStatus;
  last_sync_at: string | null;
  last_sync_message: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  profile_id: string;
  from_name: string;
  from_address: string;
  subject: string;
  received_at: string;
  is_read: number;
  has_attachments: number;
  snippet: string;
  body_text: string;
  body_html?: string | null;
}

export interface SyncLogInput {
  profileId: string;
  status: 'SUCCESS' | 'FAILED' | 'SYNCING';
  startedAt: string;
  finishedAt?: string | null;
  message: string;
}

export interface ExportableProfileRecord extends ExportAccountRecord {
  profileId: string;
}

export interface CacheStore {
  listProfiles(): MailboxProfile[];
  getProfile(profileId: string): MailboxProfile | null;
  upsertProfiles(profiles: MailboxProfile[]): void;
  updateProfileSync(profileId: string, status: ProfileStatus, message: string, syncedAt?: string | null, unreadCount?: number): void;
  listMessages(profileId?: string): MailSummary[];
  getMessage(messageId: string): MailDetail | null;
  upsertMessages(messages: MailDetail[]): void;
  updateMessageBody(message: MailDetail): void;
  insertSyncLog(input: SyncLogInput): void;
  deleteProfile(profileId: string): void;
  listExportableProfiles(since?: string | null): ExportableProfileRecord[];
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  close(): void;
}

export function createSqliteCacheStore(databasePath: string): CacheStore {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const mapProfile = (row: ProfileRow): MailboxProfile => ({
    id: row.id,
    profileName: row.profile_name,
    emailAddress: row.email_address,
    displayName: row.display_name,
    imapHost: row.imap_host ?? undefined,
    imapPort: row.imap_port ?? undefined,
    status: row.status,
    lastSyncAt: row.last_sync_at,
    lastSyncMessage: row.last_sync_message ?? undefined,
    unreadCount: row.unread_count
  });

  const mapMessageSummary = (row: MessageRow): MailSummary => ({
    id: row.id,
    profileId: row.profile_id,
    fromName: row.from_name,
    fromAddress: row.from_address,
    subject: row.subject,
    receivedAt: row.received_at,
    isRead: row.is_read === 1,
    hasAttachments: row.has_attachments === 1,
    snippet: row.snippet
  });

  const mapMessageDetail = (row: MessageRow): MailDetail => ({
    ...mapMessageSummary(row),
    bodyText: row.body_text,
    bodyHtml: row.body_html ?? undefined
  });

  return {
    listProfiles() {
      return db
        .prepare('SELECT * FROM profiles ORDER BY display_name COLLATE NOCASE ASC')
        .all()
        .map((row) => mapProfile(row as ProfileRow));
    },

    getProfile(profileId) {
      const row = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId) as ProfileRow | undefined;
      return row ? mapProfile(row) : null;
    },

    upsertProfiles(profiles) {
      const statement = db.prepare(`
        INSERT INTO profiles (
          id, profile_name, email_address, display_name, status,
          imap_host, imap_port, last_sync_at, last_sync_message, unread_count, created_at, updated_at
        ) VALUES (
          @id, @profileName, @emailAddress, @displayName, @status,
          @imapHost, @imapPort, @lastSyncAt, @lastSyncMessage, @unreadCount, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        ON CONFLICT(id) DO UPDATE SET
          profile_name = excluded.profile_name,
          email_address = excluded.email_address,
          display_name = excluded.display_name,
          imap_host = COALESCE(excluded.imap_host, profiles.imap_host),
          imap_port = COALESCE(excluded.imap_port, profiles.imap_port),
          status = excluded.status,
          last_sync_at = COALESCE(excluded.last_sync_at, profiles.last_sync_at),
          last_sync_message = COALESCE(excluded.last_sync_message, profiles.last_sync_message),
          unread_count = excluded.unread_count,
          updated_at = CURRENT_TIMESTAMP
      `);
      const transaction = db.transaction((items: MailboxProfile[]) => {
        for (const profile of items) {
          statement.run({
            ...profile,
            imapHost: profile.imapHost ?? null,
            imapPort: profile.imapPort ?? null,
            lastSyncMessage: profile.lastSyncMessage ?? null
          });
        }
      });
      transaction(profiles);
    },

    updateProfileSync(profileId, status, message, syncedAt = null, unreadCount) {
      db.prepare(
        `
        UPDATE profiles
        SET status = ?,
            last_sync_at = COALESCE(?, last_sync_at),
            last_sync_message = ?,
            unread_count = COALESCE(?, unread_count),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `
      ).run(status, syncedAt, message, unreadCount ?? null, profileId);
    },

    listMessages(profileId) {
      const sql = profileId
        ? 'SELECT * FROM messages WHERE profile_id = ? ORDER BY received_at DESC'
        : 'SELECT * FROM messages ORDER BY received_at DESC';
      const rows = profileId ? db.prepare(sql).all(profileId) : db.prepare(sql).all();
      return rows.map((row) => mapMessageSummary(row as MessageRow));
    },

    getMessage(messageId) {
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as MessageRow | undefined;
      return row ? mapMessageDetail(row) : null;
    },

    upsertMessages(messages) {
      const statement = db.prepare(`
        INSERT INTO messages (
          id, profile_id, from_name, from_address, subject, received_at,
          is_read, has_attachments, snippet, body_text, body_html, created_at, updated_at
        ) VALUES (
          @id, @profileId, @fromName, @fromAddress, @subject, @receivedAt,
          @isRead, @hasAttachments, @snippet, @bodyText, @bodyHtml, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        ON CONFLICT(id) DO UPDATE SET
          profile_id = excluded.profile_id,
          from_name = excluded.from_name,
          from_address = excluded.from_address,
          subject = excluded.subject,
          received_at = excluded.received_at,
          is_read = excluded.is_read,
          has_attachments = excluded.has_attachments,
          snippet = excluded.snippet,
          body_text = COALESCE(NULLIF(excluded.body_text, ''), messages.body_text),
          body_html = COALESCE(NULLIF(excluded.body_html, ''), messages.body_html),
          updated_at = CURRENT_TIMESTAMP
      `);
      const transaction = db.transaction((items: MailDetail[]) => {
        for (const message of items) {
          statement.run(toMessageParams(message));
        }
      });
      transaction(messages);
    },

    updateMessageBody(message) {
      db.prepare(
        `
        UPDATE messages
        SET body_text = ?, body_html = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `
      ).run(message.bodyText, message.bodyHtml ?? null, message.id);
    },

    insertSyncLog(input) {
      db.prepare(
        `
        INSERT INTO sync_logs (profile_id, status, started_at, finished_at, message)
        VALUES (?, ?, ?, ?, ?)
        `
      ).run(input.profileId, input.status, input.startedAt, input.finishedAt ?? null, input.message);
    },

    deleteProfile(profileId) {
      const transaction = db.transaction((id: string) => {
        db.prepare('DELETE FROM sync_logs WHERE profile_id = ?').run(id);
        db.prepare('DELETE FROM messages WHERE profile_id = ?').run(id);
        db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
      });
      transaction(profileId);
    },

    listExportableProfiles(since = null) {
      const sql = `
        SELECT
          id AS profileId,
          email_address AS email,
          profile_name AS profileName,
          display_name AS displayName,
          imap_host AS imapHost,
          imap_port AS imapPort,
          created_at AS createdAt,
          updated_at AS updatedAt,
          last_sync_at AS lastSyncAt,
          status AS syncStatus
        FROM profiles
        ${since ? 'WHERE datetime(updated_at) > datetime(?)' : ''}
        ORDER BY email_address COLLATE NOCASE ASC
      `;
      const rows = since ? db.prepare(sql).all(since) : db.prepare(sql).all();
      return rows as ExportableProfileRecord[];
    },

    getSetting(key) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },

    setSetting(key, value) {
      db.prepare(
        `
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = CURRENT_TIMESTAMP
        `
      ).run(key, value);
    },

    close() {
      db.close();
    }
  };
}

function migrate(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      profile_name TEXT NOT NULL,
      email_address TEXT NOT NULL,
      display_name TEXT NOT NULL,
      imap_host TEXT,
      imap_port INTEGER,
      status TEXT NOT NULL,
      last_sync_at TEXT,
      last_sync_message TEXT,
      unread_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      from_name TEXT NOT NULL,
      from_address TEXT NOT NULL,
      subject TEXT NOT NULL,
      received_at TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      snippet TEXT NOT NULL DEFAULT '',
      body_text TEXT NOT NULL DEFAULT '',
      body_html TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sync_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_messages_profile_received ON messages(profile_id, received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sync_logs_profile_started ON sync_logs(profile_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_profiles_updated ON profiles(updated_at DESC);
  `);

  const profileColumns = new Set(
    db
      .prepare('PRAGMA table_info(profiles)')
      .all()
      .map((row) => (row as { name: string }).name)
  );
  if (!profileColumns.has('imap_host')) {
    db.exec('ALTER TABLE profiles ADD COLUMN imap_host TEXT');
  }
  if (!profileColumns.has('imap_port')) {
    db.exec('ALTER TABLE profiles ADD COLUMN imap_port INTEGER');
  }

  const messageColumns = new Set(
    db
      .prepare('PRAGMA table_info(messages)')
      .all()
      .map((row) => (row as { name: string }).name)
  );
  if (!messageColumns.has('body_html')) {
    db.exec('ALTER TABLE messages ADD COLUMN body_html TEXT');
  }
}

function toMessageParams(message: MailDetail): Record<string, RowValue> {
  return {
    id: message.id,
    profileId: message.profileId,
    fromName: message.fromName,
    fromAddress: message.fromAddress,
    subject: message.subject,
    receivedAt: message.receivedAt,
    isRead: message.isRead ? 1 : 0,
    hasAttachments: message.hasAttachments ? 1 : 0,
    snippet: message.snippet,
    bodyText: message.bodyText,
    bodyHtml: message.bodyHtml ?? null
  };
}
