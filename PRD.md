# ClawInbox PRD

## 1. Product Positioning

ClawInbox is a lightweight desktop inbox client built specifically for ClawEmail. It helps users add ClawEmail mailboxes through auth-url authorization, manage many ClawEmail profiles, and reliably receive and read mail.

ClawInbox is not a general-purpose email client. It does not support IMAP, SMTP, Gmail, Outlook, 163, sending mail, AI replies, OpenClaw Skill installation, or OpenClaw Agent workflows.

## 2. Product Goals

- Let users quickly add a ClawEmail mailbox by pasting an auth-url.
- Let users add many ClawEmail mailboxes in bulk.
- Let users manage many local ClawEmail profiles from one desktop app.
- Let users refresh one mailbox or all mailboxes.
- Let users read a unified inbox aggregated from all configured ClawEmail profiles.
- Keep a local SQLite cache for mailbox metadata and message metadata/body.
- Provide Chinese, actionable diagnostics for local runtime and sync failures.

## 3. MVP Scope

### In Scope

- Add one mailbox from auth-url.
- Bulk import multiple auth-urls, initialized one by one.
- List local profiles/mailboxes.
- Refresh a single mailbox inbox.
- Refresh all mailbox inboxes.
- Show a unified inbox.
- Show sender, subject, time, read state, and attachment marker in the mail list.
- Show message body.
- Cache profile metadata and messages in local SQLite.
- Show diagnostics for Node.js, npx, mail-cli, profile readability, and last sync status.
- Chinese error messages.
- Mock UI and typed interfaces before wiring real ClawEmail commands.

### Out of Scope

- Sending mail.
- Attachment download.
- AI replies or AI classification.
- Mail categories.
- IMAP/SMTP.
- Regular mailbox providers.
- Skill installation.
- OpenClaw Agent integration.
- Multi-language support.
- Complex rules engine.

## 4. Users

Primary users are operators or developers who own many ClawEmail profiles and need a focused inbox dashboard. They value bulk setup, clear profile status, and predictable local operation over traditional email-client features.

## 5. Core User Flows

### Add One Mailbox

1. User opens the add mailbox dialog.
2. User pastes one ClawEmail auth-url.
3. Renderer sends the auth-url to main process through IPC.
4. Main process calls `clawCliAdapter.initializeProfile`.
5. The adapter runs `npx "@clawemail/claw-setup@latest" --auth-url "<auth-url>"` with array arguments and `shell: false`.
6. Renderer clears the auth-url field after completion.
7. The profile list updates.

### Bulk Import Mailboxes

1. User opens the bulk import dialog.
2. User pastes multiple auth-urls, one per line.
3. Renderer trims and de-duplicates empty lines.
4. Main process initializes profiles sequentially.
5. UI shows per-item success/failure summaries in Chinese.
6. Renderer clears the auth-url input after completion.

### Read Mail

1. User opens the unified inbox.
2. App lists latest messages from all profiles.
3. User selects a message.
4. App shows sender, subject, time, source mailbox, and message body.

### Diagnose Status

1. User opens the diagnostics page.
2. App checks Node.js, npx, mail-cli, profile readability, and last sync status.
3. App displays OK, warning, or error states with Chinese messages.

## 6. Data Requirements

### Persisted Locally

- Profile name.
- Email address.
- Display name.
- Profile status.
- Last sync time.
- Mail metadata.
- Mail body.

### Never Persisted

- auth-url.
- Full command line containing auth-url.
- Logs containing auth-url.

## 7. Security Requirements

- Renderer must not execute commands.
- All command execution happens in Electron main process.
- ClawEmail commands must be isolated in `clawCliAdapter`.
- Use `execa` or `child_process.spawn`.
- Never use `shell: true`.
- Command arguments must be passed as arrays.
- Do not concatenate command strings.
- Do not write auth-url to database.
- Do not write auth-url to logs.
- Clear auth-url fields after initialization.

## 8. MVP Acceptance Criteria

- App has a running Electron + React + TypeScript project structure.
- `PRD.md`, `ARCHITECTURE.md`, and `ROADMAP.md` exist.
- `clawCliAdapter` exposes typed mock-ready interfaces.
- Mock UI includes profile list, unified mail list, message detail, refresh all, add mailbox, bulk import, and diagnostics page.
- Renderer only calls typed preload APIs.
- Main process owns all ClawEmail adapter calls.
- Basic tests pass.
- Production build succeeds.

