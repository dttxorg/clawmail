import { createHash, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Database as DatabaseConnection } from 'better-sqlite3';

export interface GuestAccessKeyMetadata {
  profileId: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface GuestAccessKeyResult extends GuestAccessKeyMetadata {
  key: string;
}

interface GuestAccessKeyRow {
  profile_id: string;
  created_at: string;
  last_used_at: string | null;
}

export interface AccessKeyStore {
  ensureAccessKey(profileId: string): GuestAccessKeyResult | GuestAccessKeyMetadata;
  rotateAccessKey(profileId: string): GuestAccessKeyResult;
  verifyAccessKey(key: string): string | null;
  listAccessKeys(profileIds?: string[]): GuestAccessKeyMetadata[];
  close(): void;
}

export function createSqliteAccessKeyStore(databasePath: string): AccessKeyStore {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  migrate(db);

  return {
    ensureAccessKey(profileId) {
      const existing = activeKeyForProfile(db, profileId);
      if (existing) return mapRow(existing);
      return insertAccessKey(db, profileId);
    },
    rotateAccessKey(profileId) {
      const transaction = db.transaction((id: string) => {
        db.prepare('UPDATE guest_access_keys SET revoked_at = CURRENT_TIMESTAMP WHERE profile_id = ? AND revoked_at IS NULL').run(id);
        return insertAccessKey(db, id);
      });
      return transaction(profileId);
    },
    verifyAccessKey(key) {
      if (!isGuestAccessKey(key)) return null;

      const row = db
        .prepare(
          `
          SELECT profile_id
          FROM guest_access_keys
          WHERE key_hash = ? AND revoked_at IS NULL
          `
        )
        .get(hashAccessKey(key)) as { profile_id: string } | undefined;
      if (!row) return null;

      db.prepare('UPDATE guest_access_keys SET last_used_at = CURRENT_TIMESTAMP WHERE key_hash = ?').run(hashAccessKey(key));
      return row.profile_id;
    },
    listAccessKeys(profileIds) {
      const rows = profileIds?.length
        ? db
            .prepare(
              `
              SELECT profile_id, created_at, last_used_at
              FROM guest_access_keys
              WHERE revoked_at IS NULL AND profile_id IN (${profileIds.map(() => '?').join(',')})
              ORDER BY created_at DESC
              `
            )
            .all(...profileIds)
        : db
            .prepare(
              `
              SELECT profile_id, created_at, last_used_at
              FROM guest_access_keys
              WHERE revoked_at IS NULL
              ORDER BY created_at DESC
              `
            )
            .all();
      return rows.map((row) => mapRow(row as GuestAccessKeyRow));
    },
    close() {
      db.close();
    }
  };
}

function migrate(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS guest_access_keys (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT,
      revoked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_guest_access_keys_profile
      ON guest_access_keys(profile_id, revoked_at);
  `);
}

function activeKeyForProfile(db: DatabaseConnection, profileId: string): GuestAccessKeyRow | null {
  const row = db
    .prepare(
      `
      SELECT profile_id, created_at, last_used_at
      FROM guest_access_keys
      WHERE profile_id = ? AND revoked_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
      `
    )
    .get(profileId) as GuestAccessKeyRow | undefined;
  return row ?? null;
}

function insertAccessKey(db: DatabaseConnection, profileId: string): GuestAccessKeyResult {
  const key = createGuestAccessKey();
  const id = randomBytes(16).toString('hex');
  db.prepare(
    `
    INSERT INTO guest_access_keys (id, profile_id, key_hash)
    VALUES (?, ?, ?)
    `
  ).run(id, profileId, hashAccessKey(key));

  const row = activeKeyForProfile(db, profileId);
  if (!row) throw new Error('访客密钥生成失败。');
  return { ...mapRow(row), key };
}

function mapRow(row: GuestAccessKeyRow): GuestAccessKeyMetadata {
  return {
    profileId: row.profile_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at
  };
}

function createGuestAccessKey(): string {
  return `ck_guest_${randomBytes(24).toString('base64url')}`;
}

function hashAccessKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function isGuestAccessKey(key: string): boolean {
  return /^ck_guest_[A-Za-z0-9_-]{24,}$/.test(key);
}
