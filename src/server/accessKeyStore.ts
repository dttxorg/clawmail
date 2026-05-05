import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Database as DatabaseConnection } from 'better-sqlite3';

export interface GuestAccessKeyMetadata {
  profileId: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface GuestAccessKeyResult extends GuestAccessKeyMetadata {
  key: string;
}

interface GuestAccessKeyRow {
  profile_id: string;
  encrypted_key: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

export interface AccessKeyStore {
  ensureAccessKey(profileId: string): GuestAccessKeyResult | GuestAccessKeyMetadata;
  getAccessKey(profileId: string): GuestAccessKeyResult;
  rotateAccessKey(profileId: string, expiresAt?: string | null): GuestAccessKeyResult;
  setAccessKeyExpiration(profileId: string, expiresAt: string | null): GuestAccessKeyMetadata;
  verifyAccessKey(key: string): string | null;
  listAccessKeys(profileIds?: string[]): GuestAccessKeyMetadata[];
  close(): void;
}

export function createSqliteAccessKeyStore(databasePath: string, encryptionSecret = 'development-master-key'): AccessKeyStore {
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
      return insertAccessKey(db, profileId, encryptionSecret, null);
    },
    getAccessKey(profileId) {
      const existing = activeKeyForProfile(db, profileId);
      if (!existing) return insertAccessKey(db, profileId, encryptionSecret, null);

      const key = decryptAccessKey(existing.encrypted_key, encryptionSecret);
      if (key) return { ...mapRow(existing), key };

      const transaction = db.transaction((id: string) => {
        db.prepare('UPDATE guest_access_keys SET revoked_at = CURRENT_TIMESTAMP WHERE profile_id = ? AND revoked_at IS NULL').run(id);
        return insertAccessKey(db, id, encryptionSecret, null);
      });
      return transaction(profileId);
    },
    rotateAccessKey(profileId, expiresAt = null) {
      const transaction = db.transaction((id: string) => {
        db.prepare('UPDATE guest_access_keys SET revoked_at = CURRENT_TIMESTAMP WHERE profile_id = ? AND revoked_at IS NULL').run(id);
        return insertAccessKey(db, id, encryptionSecret, expiresAt);
      });
      return transaction(profileId);
    },
    setAccessKeyExpiration(profileId, expiresAt) {
      const existing = activeKeyForProfile(db, profileId);
      if (!existing) return insertAccessKey(db, profileId, encryptionSecret, expiresAt);

      db.prepare(
        `
        UPDATE guest_access_keys
        SET expires_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE profile_id = ? AND revoked_at IS NULL
        `
      ).run(expiresAt, profileId);
      return mapRow(activeKeyForProfile(db, profileId) ?? existing);
    },
    verifyAccessKey(key) {
      if (!isGuestAccessKey(key)) return null;

      const row = db
        .prepare(
          `
          SELECT profile_id
          FROM guest_access_keys
          WHERE key_hash = ?
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
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
              SELECT profile_id, created_at, last_used_at, expires_at
              FROM guest_access_keys
              WHERE revoked_at IS NULL AND profile_id IN (${profileIds.map(() => '?').join(',')})
              ORDER BY created_at DESC
              `
            )
            .all(...profileIds)
        : db
            .prepare(
              `
              SELECT profile_id, created_at, last_used_at, expires_at
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
      encrypted_key TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT,
      revoked_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_guest_access_keys_profile
      ON guest_access_keys(profile_id, revoked_at);
  `);

  const columns = new Set(
    db
      .prepare('PRAGMA table_info(guest_access_keys)')
      .all()
      .map((row) => (row as { name: string }).name)
  );
  if (!columns.has('encrypted_key')) {
    db.exec('ALTER TABLE guest_access_keys ADD COLUMN encrypted_key TEXT');
  }
  if (!columns.has('expires_at')) {
    db.exec('ALTER TABLE guest_access_keys ADD COLUMN expires_at TEXT');
  }
  if (!columns.has('updated_at')) {
    db.exec('ALTER TABLE guest_access_keys ADD COLUMN updated_at TEXT');
  }
}

function activeKeyForProfile(db: DatabaseConnection, profileId: string): GuestAccessKeyRow | null {
  const row = db
    .prepare(
      `
      SELECT profile_id, encrypted_key, created_at, last_used_at, expires_at
      FROM guest_access_keys
      WHERE profile_id = ? AND revoked_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
      `
    )
    .get(profileId) as GuestAccessKeyRow | undefined;
  return row ?? null;
}

function insertAccessKey(db: DatabaseConnection, profileId: string, encryptionSecret: string, expiresAt: string | null): GuestAccessKeyResult {
  const key = createGuestAccessKey();
  const id = randomBytes(16).toString('hex');
  db.prepare(
    `
    INSERT INTO guest_access_keys (id, profile_id, key_hash, encrypted_key, expires_at)
    VALUES (?, ?, ?, ?, ?)
    `
  ).run(id, profileId, hashAccessKey(key), encryptAccessKey(key, encryptionSecret), expiresAt);

  const row = activeKeyForProfile(db, profileId);
  if (!row) throw new Error('访客密钥生成失败。');
  return { ...mapRow(row), key };
}

function mapRow(row: GuestAccessKeyRow): GuestAccessKeyMetadata {
  return {
    profileId: row.profile_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at
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

function encryptAccessKey(value: string, encryptionSecret: string): string {
  const iv = randomBytes(12);
  const key = createHash('sha256').update(encryptionSecret).digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    data.toString('base64url')
  ].join('.');
}

function decryptAccessKey(value: string | null, encryptionSecret: string): string | null {
  if (!value) return null;
  const [iv, tag, data] = value.split('.');
  if (!iv || !tag || !data) return null;

  try {
    const key = createHash('sha256').update(encryptionSecret).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    return null;
  }
}
