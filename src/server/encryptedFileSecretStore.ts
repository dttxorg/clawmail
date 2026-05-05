import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { SecretStore } from '../main/secretStore';

interface StoredSecret {
  iv: string;
  tag: string;
  data: string;
}

type SecretFile = Record<string, StoredSecret>;

export function createEncryptedFileSecretStore(filePath: string, masterKey: string): SecretStore {
  if (!masterKey.trim()) {
    throw new Error('CLAWMAIL_MASTER_KEY 不能为空。');
  }

  const key = createHash('sha256').update(masterKey).digest();
  let writeQueue = Promise.resolve();

  async function load(): Promise<SecretFile> {
    try {
      return JSON.parse(await readFile(filePath, 'utf8')) as SecretFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  async function save(values: SecretFile): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(values, null, 2)}\n`, 'utf8');
    await rename(tempPath, filePath);
  }

  function encrypt(value: string): StoredSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      data: data.toString('base64url')
    };
  }

  function decrypt(value: StoredSecret): string {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(value.data, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  }

  async function mutate(callback: (values: SecretFile) => void): Promise<void> {
    writeQueue = writeQueue.then(async () => {
      const values = await load();
      callback(values);
      await save(values);
    });
    await writeQueue;
  }

  return {
    async setPassword(account, password) {
      await mutate((values) => {
        values[account] = encrypt(password);
      });
    },
    async getPassword(account) {
      const values = await load();
      const value = values[account];
      return value ? decrypt(value) : null;
    },
    async deletePassword(account) {
      await mutate((values) => {
        delete values[account];
      });
    }
  };
}
