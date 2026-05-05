export type ProfileStatus = 'READY' | 'INITIALIZING' | 'SYNCING' | 'ERROR';

export type DiagnosticStatus = 'OK' | 'WARN' | 'ERROR' | 'CHECKING';

export interface MailboxProfile {
  id: string;
  profileName: string;
  emailAddress: string;
  displayName: string;
  imapHost?: string;
  imapPort?: number;
  status: ProfileStatus;
  lastSyncAt: string | null;
  lastSyncMessage?: string;
  unreadCount: number;
}

export interface MailSummary {
  id: string;
  profileId: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  receivedAt: string;
  isRead: boolean;
  hasAttachments: boolean;
  snippet: string;
}

export interface MailDetail extends MailSummary {
  bodyText: string;
  bodyHtml?: string;
}

export interface DiagnosticItem {
  id: string;
  label: string;
  status: DiagnosticStatus;
  message: string;
  checkedAt: string;
}

export interface InitializeProfileInput {
  authUrl: string;
  duplicateAction?: 'update' | 'skip' | 'cancel';
}

export interface BatchInitializeProfilesInput {
  authUrls: string[];
}

export interface InitializeProfileResult {
  ok: boolean;
  profile?: MailboxProfile;
  profiles?: MailboxProfile[];
  items?: ImportMailboxItemResult[];
  message: string;
}

export interface ImportMailboxItemResult {
  ok: boolean;
  emailAddress: string;
  displayName: string;
  action: 'added' | 'updated' | 'skipped' | 'failed';
  message: string;
}

export interface InitializeProfilePreviewAccount {
  emailAddress: string;
  displayName: string;
  profileName: string;
  exists: boolean;
}

export interface InitializeProfilePreviewResult {
  ok: boolean;
  accounts: InitializeProfilePreviewAccount[];
  hasDuplicates: boolean;
  message: string;
}

export interface DeleteProfileResult {
  ok: boolean;
  profileId: string;
  message: string;
}

export type AccountsExportMode = 'full' | 'incremental';

export interface ExportAccountsInput {
  mode: AccountsExportMode;
  since?: string | null;
  outputPath?: string;
  includeCredentials?: boolean;
  credentialExportMode?: 'encrypted' | 'plaintext';
  backupPassword?: string | null;
}

export interface ExportAccountRecord {
  email: string;
  profileName: string;
  displayName: string;
  imapHost: string | null;
  imapPort: number | null;
  createdAt: string;
  updatedAt: string;
  lastSyncAt: string | null;
  syncStatus: ProfileStatus;
}

export interface ExportAccountsResult {
  ok: boolean;
  filePath?: string;
  exportedCount: number;
  since?: string | null;
  lastExportAt?: string;
  message: string;
}

export interface SyncResult {
  ok: boolean;
  profileId: string;
  syncedAt: string;
  message: string;
}

export interface ClawInboxApi {
  listProfiles(): Promise<MailboxProfile[]>;
  listUnifiedInbox(): Promise<MailSummary[]>;
  getMessage(messageId: string): Promise<MailDetail>;
  refreshProfile(profileId: string): Promise<SyncResult>;
  refreshAll(): Promise<SyncResult[]>;
  addMailbox(input: InitializeProfileInput): Promise<InitializeProfileResult>;
  importMailboxes(input: BatchInitializeProfilesInput): Promise<InitializeProfileResult[]>;
  importMailboxFromClipboard(): Promise<InitializeProfileResult>;
  deleteProfile(profileId: string): Promise<DeleteProfileResult>;
  exportAccounts(input: ExportAccountsInput): Promise<ExportAccountsResult>;
  openExternalLink(url: string): Promise<{ ok: boolean; message: string }>;
  getDiagnostics(): Promise<DiagnosticItem[]>;
}
