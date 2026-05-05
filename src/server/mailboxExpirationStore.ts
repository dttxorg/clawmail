import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Database as DatabaseConnection } from 'better-sqlite3';

export interface MailboxExpiration {
  profileId: string;
  expiresAt: string | null;
}

interface MailboxExpirationRow {
  profile_id: string;
  expires_at: string | null;
}

export interface MailboxExpirationStore {
  getExpiration(profileId: string): MailboxExpiration | null;
  setExpiration(profileId: string, expiresAt: string | null): MailboxExpiration;
  listExpirations(profileIds?: string[]): MailboxExpiration[];
  isExpired(profileId: string, now?: Date): boolean;
  close(): void;
}

export function createSqliteMailboxExpirationStore(databasePath: string): MailboxExpirationStore {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  migrate(db);

  return {
    getExpiration(profileId) {
      const row = db.prepare('SELECT profile_id, expires_at FROM mailbox_expirations WHERE profile_id = ?').get(profileId) as MailboxExpirationRow | undefined;
      return row ? mapRow(row) : null;
    },
    setExpiration(profileId, expiresAt) {
      db.prepare(
        `
        INSERT INTO mailbox_expirations (profile_id, expires_at, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(profile_id) DO UPDATE SET
          expires_at = excluded.expires_at,
          updated_at = CURRENT_TIMESTAMP
        `
      ).run(profileId, expiresAt);
      return { profileId, expiresAt };
    },
    listExpirations(profileIds) {
      const rows = profileIds?.length
        ? db
            .prepare(
              `
              SELECT profile_id, expires_at
              FROM mailbox_expirations
              WHERE profile_id IN (${profileIds.map(() => '?').join(',')})
              ORDER BY expires_at ASC
              `
            )
            .all(...profileIds)
        : db.prepare('SELECT profile_id, expires_at FROM mailbox_expirations ORDER BY expires_at ASC').all();
      return rows.map((row) => mapRow(row as MailboxExpirationRow));
    },
    isExpired(profileId, now = new Date()) {
      const expiration = this.getExpiration(profileId);
      if (!expiration?.expiresAt) return false;
      return new Date(expiration.expiresAt).getTime() <= now.getTime();
    },
    close() {
      db.close();
    }
  };
}

function migrate(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mailbox_expirations (
      profile_id TEXT PRIMARY KEY,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function mapRow(row: MailboxExpirationRow): MailboxExpiration {
  return {
    profileId: row.profile_id,
    expiresAt: row.expires_at
  };
}
