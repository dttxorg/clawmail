import { app, clipboard, dialog, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import type { ClawCliAdapter } from './clawCliAdapter';
import { buildAccountsExportFileName } from './clawCliAdapter';
import { INVALID_AUTH_URL_MESSAGE, parseClawEmailAuthToken } from './clawAuthTokenParser';
import type { BatchInitializeProfilesInput, ExportAccountsInput, InitializeProfileInput } from '../shared/types';

export const channels = {
  listProfiles: 'clawinbox:profiles:list',
  listUnifiedInbox: 'clawinbox:inbox:list',
  getMessage: 'clawinbox:messages:get',
  refreshProfile: 'clawinbox:profiles:refresh',
  refreshAll: 'clawinbox:profiles:refresh-all',
  addMailbox: 'clawinbox:mailboxes:add',
  importMailboxes: 'clawinbox:mailboxes:import',
  importMailboxFromClipboard: 'clawinbox:mailboxes:import-from-clipboard',
  deleteProfile: 'clawinbox:profiles:delete',
  exportAccounts: 'clawinbox:accounts:export',
  openExternalLink: 'clawinbox:links:open-external',
  getDiagnostics: 'clawinbox:diagnostics:get'
} as const;

export function registerClawInboxIpc(adapter: ClawCliAdapter): void {
  ipcMain.handle(channels.listProfiles, () => adapter.listProfiles());
  ipcMain.handle(channels.listUnifiedInbox, () => adapter.listUnifiedInbox());
  ipcMain.handle(channels.getMessage, (_event, messageId: string) => adapter.getMessage(messageId));
  ipcMain.handle(channels.refreshProfile, (_event, profileId: string) => adapter.refreshProfile(profileId));
  ipcMain.handle(channels.refreshAll, () => adapter.refreshAll());
  ipcMain.handle(channels.addMailbox, async (_event, input: InitializeProfileInput) => {
    return adapter.initializeProfile(input);
  });
  ipcMain.handle(channels.importMailboxes, async (_event, input: BatchInitializeProfilesInput) => {
    const results = [];
    for (const authUrl of input.authUrls) {
      results.push(await adapter.initializeProfile({ authUrl }));
    }
    return results;
  });
  ipcMain.handle(channels.importMailboxFromClipboard, async () => {
    const token = parseClawEmailAuthToken(clipboard.readText());
    if (!token) {
      return { ok: false, message: INVALID_AUTH_URL_MESSAGE };
    }

    const preview = await adapter.previewInitializeProfile({ authUrl: token });
    if (!preview.ok) {
      return { ok: false, message: preview.message };
    }

    const accountList = preview.accounts
      .map((account) => `${account.exists ? '已存在' : '新邮箱'}：${account.emailAddress}`)
      .join('\n');
    const buttons = preview.hasDuplicates ? ['更新凭据', '跳过重复', '取消'] : ['导入', '取消'];
    const result = await dialog.showMessageBox({
      type: 'question',
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      title: '从剪贴板导入 ClawEmail',
      message: `检测到 ${preview.accounts.length} 个 ClawEmail 邮箱，是否导入？`,
      detail: `${accountList}\n\nClawInbox 只会提取 auth-url 口令并走 Hermes client mode，不会执行剪贴板中的 npx、curl 或 bash 命令。`
    });
    if (result.response === buttons.length - 1) {
      return { ok: false, message: '已取消从剪贴板导入。' };
    }

    return adapter.initializeProfile({
      authUrl: token,
      duplicateAction: preview.hasDuplicates && result.response === 1 ? 'skip' : 'update'
    });
  });
  ipcMain.handle(channels.deleteProfile, (_event, profileId: string) => adapter.deleteProfile(profileId));
  ipcMain.handle(channels.exportAccounts, async (_event, input: ExportAccountsInput) => {
    let outputPath = input.outputPath;
    if (!outputPath) {
      const result = await dialog.showSaveDialog({
        title: '导出 ClawInbox 账号',
        defaultPath: join(app.getPath('documents'), buildAccountsExportFileName()),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (result.canceled || !result.filePath) {
        return { ok: false, exportedCount: 0, message: '已取消导出。' };
      }
      outputPath = result.filePath;
    }
    return adapter.exportAccounts({ ...input, outputPath });
  });
  ipcMain.handle(channels.openExternalLink, async (_event, url: string) => {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
        return { ok: false, message: '链接协议不受支持。' };
      }
      await shell.openExternal(parsed.toString());
      return { ok: true, message: '已在系统浏览器打开链接。' };
    } catch {
      return { ok: false, message: '链接无效，无法打开。' };
    }
  });
  ipcMain.handle(channels.getDiagnostics, () => adapter.getDiagnostics());
}
