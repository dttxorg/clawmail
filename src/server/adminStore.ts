import { timingSafeEqual, randomBytes, scryptSync } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Database as DatabaseConnection } from 'better-sqlite3';

export interface AdminAuthResult {
  ok: boolean;
  mustChangePassword: boolean;
}

interface AdminRow {
  username: string;
  password_hash: string;
  must_change_password: number;
}

export interface AdminStore {
  verify(username: string, password: string): AdminAuthResult;
  changePassword(username: string, currentPassword: string, newPassword: string): AdminAuthResult;
  close(): void;
}

export function createSqliteAdminStore(databasePath: string, defaultUsername = 'admin', defaultPassword = 'admin'): AdminStore {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  migrate(db);
  ensureDefaultAdmin(db, defaultUsername, defaultPassword);

  return {
    verify(username, password) {
      const row = getAdminRow(db, username);
      if (!row || !verifyPassword(password, row.password_hash)) {
        return { ok: false, mustChangePassword: false };
      }
      return { ok: true, mustChangePassword: row.must_change_password === 1 };
    },
    changePassword(username, currentPassword, newPassword) {
      if (newPassword.length < 6) {
        throw new Error('新密码至少需要 6 位。');
      }
      const row = getAdminRow(db, username);
      if (!row || !verifyPassword(currentPassword, row.password_hash)) {
        return { ok: false, mustChangePassword: false };
      }
      db.prepare(
        `
        UPDATE admin_credentials
        SET password_hash = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP
        WHERE username = ?
        `
      ).run(hashPassword(newPassword), username);
      return { ok: true, mustChangePassword: false };
    },
    close() {
      db.close();
    }
  };
}

function migrate(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_credentials (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function ensureDefaultAdmin(db: DatabaseConnection, username: string, password: string): void {
  const row = getAdminRow(db, username);
  if (row) return;
  db.prepare(
    `
    INSERT INTO admin_credentials (username, password_hash, must_change_password)
    VALUES (?, ?, 1)
    `
  ).run(username, hashPassword(password));
}

function getAdminRow(db: DatabaseConnection, username: string): AdminRow | null {
  return (db.prepare('SELECT * FROM admin_credentials WHERE username = ?').get(username) as AdminRow | undefined) ?? null;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, salt, expected] = encoded.split(':');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;

  const actual = scryptSync(password, Buffer.from(salt, 'base64url'), 64);
  const expectedBuffer = Buffer.from(expected, 'base64url');
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}
