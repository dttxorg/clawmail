import { execa } from 'execa';

export interface SecretStore {
  setPassword(account: string, password: string): Promise<void>;
  getPassword(account: string): Promise<string | null>;
  deletePassword(account: string): Promise<void>;
}

const SERVICE_NAME = 'ClawInbox.ClawEmail.IMAP';

export function createSystemSecretStore(): SecretStore {
  if (process.env.CLAWINBOX_SECRET_STORE === 'memory') return createMemorySecretStore();

  if (process.platform === 'darwin') return createMacosKeychainSecretStore();
  if (process.platform === 'linux') return createLinuxSecretServiceStore();
  if (process.platform === 'win32') return createWindowsCredentialManagerSecretStore();

  return createUnsupportedSecretStore('当前系统暂不支持安全凭据存储。');
}

function createWindowsCredentialManagerSecretStore(): SecretStore {
  return {
    async setPassword(account, password) {
      await execa('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SET_SCRIPT, credentialTarget(account)], {
        shell: false,
        input: password,
        reject: true
      });
    },
    async getPassword(account) {
      const result = await execa('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_GET_SCRIPT, credentialTarget(account)], {
        shell: false,
        reject: false
      });
      if (result.exitCode !== 0) return null;
      return result.stdout || null;
    },
    async deletePassword(account) {
      await execa('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_DELETE_SCRIPT, credentialTarget(account)], {
        shell: false,
        reject: false
      });
    }
  };
}

function credentialTarget(account: string): string {
  return `${SERVICE_NAME}:${account}`;
}

export function createMemorySecretStore(initial: Record<string, string> = {}): SecretStore {
  const values = new Map(Object.entries(initial));
  return {
    async setPassword(account, password) {
      values.set(account, password);
    },
    async getPassword(account) {
      return values.get(account) ?? null;
    },
    async deletePassword(account) {
      values.delete(account);
    }
  };
}

function createMacosKeychainSecretStore(): SecretStore {
  return {
    async setPassword(account, password) {
      await execa('security', ['add-generic-password', '-a', account, '-s', SERVICE_NAME, '-w', password, '-U'], {
        shell: false,
        reject: true
      });
    },
    async getPassword(account) {
      const result = await execa('security', ['find-generic-password', '-a', account, '-s', SERVICE_NAME, '-w'], {
        shell: false,
        reject: false
      });
      if (result.exitCode !== 0) return null;
      return result.stdout.trim() || null;
    },
    async deletePassword(account) {
      await execa('security', ['delete-generic-password', '-a', account, '-s', SERVICE_NAME], {
        shell: false,
        reject: false
      });
    }
  };
}

function createLinuxSecretServiceStore(): SecretStore {
  return {
    async setPassword(account, password) {
      await execa('secret-tool', ['store', '--label', `ClawInbox ${account}`, 'service', SERVICE_NAME, 'account', account], {
        shell: false,
        input: password,
        reject: true
      });
    },
    async getPassword(account) {
      const result = await execa('secret-tool', ['lookup', 'service', SERVICE_NAME, 'account', account], {
        shell: false,
        reject: false
      });
      if (result.exitCode !== 0) return null;
      return result.stdout.trim() || null;
    },
    async deletePassword(account) {
      await execa('secret-tool', ['clear', 'service', SERVICE_NAME, 'account', account], {
        shell: false,
        reject: false
      });
    }
  };
}

function createUnsupportedSecretStore(message: string): SecretStore {
  return {
    async setPassword() {
      throw new Error(message);
    },
    async getPassword() {
      throw new Error(message);
    },
    async deletePassword() {
      throw new Error(message);
    }
  };
}

const WINDOWS_CREDENTIAL_TYPES = String.raw`
using System;
using System.Runtime.InteropServices;
public static class NativeCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credentialPtr);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern void CredFree(IntPtr credentialPtr);
}
`;

const WINDOWS_SET_SCRIPT = String.raw`
param([string]$target)
Add-Type -TypeDefinition @'
${WINDOWS_CREDENTIAL_TYPES}
'@
$secret = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::Unicode.GetBytes($secret)
$ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
try {
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
  $cred = New-Object NativeCred+CREDENTIAL
  $cred.Type = 1
  $cred.TargetName = $target
  $cred.CredentialBlobSize = $bytes.Length
  $cred.CredentialBlob = $ptr
  $cred.Persist = 2
  $cred.UserName = $target
  if (-not [NativeCred]::CredWrite([ref]$cred, 0)) { exit 1 }
} finally {
  [Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
}
`;

const WINDOWS_GET_SCRIPT = String.raw`
param([string]$target)
Add-Type -TypeDefinition @'
${WINDOWS_CREDENTIAL_TYPES}
'@
$ptr = [IntPtr]::Zero
if (-not [NativeCred]::CredRead($target, 1, 0, [ref]$ptr)) { exit 1 }
try {
  $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][NativeCred+CREDENTIAL])
  $bytes = New-Object byte[] $cred.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $bytes.Length)
  [Console]::Out.Write([Text.Encoding]::Unicode.GetString($bytes))
} finally {
  [NativeCred]::CredFree($ptr)
}
`;

const WINDOWS_DELETE_SCRIPT = String.raw`
param([string]$target)
Add-Type -TypeDefinition @'
${WINDOWS_CREDENTIAL_TYPES}
'@
[void][NativeCred]::CredDelete($target, 1, 0)
`;
