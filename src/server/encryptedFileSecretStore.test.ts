import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createEncryptedFileSecretStore } from './encryptedFileSecretStore';

describe('encrypted file secret store', () => {
  it('persists encrypted passwords without plaintext leakage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'clawmail-secret-'));
    const filePath = join(dir, 'secrets.json');
    const store = createEncryptedFileSecretStore(filePath, 'master-key');

    await store.setPassword('profile-1', 'AUTH_CODE_SECRET');

    expect(await store.getPassword('profile-1')).toBe('AUTH_CODE_SECRET');
    expect(await readFile(filePath, 'utf8')).not.toContain('AUTH_CODE_SECRET');

    await store.deletePassword('profile-1');
    expect(await store.getPassword('profile-1')).toBeNull();
  });
});
