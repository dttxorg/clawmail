import { contextBridge, ipcRenderer } from 'electron';
import { channels } from '../main/ipc';
import type {
  BatchInitializeProfilesInput,
  ClawInboxApi,
  ExportAccountsInput,
  InitializeProfileInput
} from '../shared/types';

const api: ClawInboxApi = {
  listProfiles: () => ipcRenderer.invoke(channels.listProfiles),
  listUnifiedInbox: () => ipcRenderer.invoke(channels.listUnifiedInbox),
  getMessage: (messageId: string) => ipcRenderer.invoke(channels.getMessage, messageId),
  refreshProfile: (profileId: string) => ipcRenderer.invoke(channels.refreshProfile, profileId),
  refreshAll: () => ipcRenderer.invoke(channels.refreshAll),
  addMailbox: (input: InitializeProfileInput) => ipcRenderer.invoke(channels.addMailbox, input),
  importMailboxes: (input: BatchInitializeProfilesInput) => ipcRenderer.invoke(channels.importMailboxes, input),
  importMailboxFromClipboard: () => ipcRenderer.invoke(channels.importMailboxFromClipboard),
  deleteProfile: (profileId: string) => ipcRenderer.invoke(channels.deleteProfile, profileId),
  exportAccounts: (input: ExportAccountsInput) => ipcRenderer.invoke(channels.exportAccounts, input),
  openExternalLink: (url: string) => ipcRenderer.invoke(channels.openExternalLink, url),
  getDiagnostics: () => ipcRenderer.invoke(channels.getDiagnostics)
};

contextBridge.exposeInMainWorld('clawInbox', api);
