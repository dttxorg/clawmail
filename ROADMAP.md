# ClawInbox Roadmap

## Overview

The first milestone creates a working mock desktop app with documentation, architecture contracts, and tests. Later milestones connect SQLite and real ClawEmail commands without changing renderer boundaries.

## Phase 1: Mock App and Contracts

### Task 1: Product and Architecture Documents

**Description:** Create PRD, architecture, and implementation roadmap documents that lock MVP scope and non-goals.

**Acceptance criteria:**
- [x] `PRD.md` documents goals, MVP scope, non-goals, flows, and security requirements.
- [x] `ARCHITECTURE.md` documents process boundaries, IPC, adapter, and SQLite plan.
- [x] `ROADMAP.md` breaks implementation into testable tasks.

**Verification:**
- [x] Documents exist and match the requested ClawInbox constraints.

**Dependencies:** None

**Estimated scope:** Small

### Task 2: Project Foundation

**Description:** Initialize Electron + React + TypeScript project structure with build and test scripts.

**Acceptance criteria:**
- [x] Electron main, preload, renderer, and shared type folders exist.
- [x] `npm run test` is configured.
- [x] `npm run build` is configured.

**Verification:**
- [ ] `npm install`
- [ ] `npm run test`
- [ ] `npm run build`

**Dependencies:** Task 1

**Estimated scope:** Medium

### Task 3: Claw CLI Adapter Interface

**Description:** Define a typed `clawCliAdapter` contract with mock and real command construction.

**Acceptance criteria:**
- [x] Renderer cannot call the adapter directly.
- [x] The real setup command uses `npx` with array arguments.
- [x] `shell: true` is not used.
- [x] auth-url is not logged or persisted.

**Verification:**
- [ ] Adapter tests pass.

**Dependencies:** Task 2

**Estimated scope:** Medium

### Task 4: Mock Inbox UI

**Description:** Build the first runnable UI with profile list, unified inbox, message detail, refresh all, add mailbox, bulk import, and diagnostics.

**Acceptance criteria:**
- [x] Left panel shows profiles/mailboxes.
- [x] Middle panel shows unified mail list.
- [x] Right panel shows selected mail detail.
- [x] Header includes refresh all.
- [x] Add mailbox modal exists.
- [x] Bulk import modal exists.
- [x] Diagnostics page exists.

**Verification:**
- [ ] UI render test passes.
- [ ] App can be launched with `npm run dev`.

**Dependencies:** Task 3

**Estimated scope:** Medium

### Task 5: First Verification Checkpoint

**Description:** Install dependencies, run tests, and run the production build.

**Acceptance criteria:**
- [ ] Dependencies install successfully.
- [ ] Tests pass.
- [ ] Build succeeds.

**Verification:**
- [ ] `npm run test`
- [ ] `npm run build`

**Dependencies:** Tasks 1-4

**Estimated scope:** Small

## Phase 2: Real ClawEmail / mail-cli Adapter

- [x] Detect Node.js and npx.
- [x] Detect local `mail-cli`, with npx package fallback.
- [x] Parse official install commands and initialize mail-cli profiles without running `curl | bash` or OpenClaw plugin installation.
- [x] Re-scan profiles after setup.
- [x] Read profiles through `mail-cli --json auth list`.
- [x] Read inbox messages through `mail-cli --json mail list`.
- [x] Read message bodies through `mail-cli --json read body`.
- [x] Keep renderer command-free.
- [x] Keep mock adapter for tests and `CLAWINBOX_ADAPTER=mock`.
- [x] Run `npm run test`.
- [x] Run `npm run build`.

## Phase 3: SQLite Cache and Sync State

- [x] Add SQLite connection and migrations.
- [x] Create `profiles`, `messages`, and `sync_logs` tables.
- [x] Store profile metadata after successful profile scans.
- [x] Store mail metadata after successful inbox refresh.
- [x] Store message body after successful body read.
- [x] Load cached data first at startup.
- [x] Trigger a background refresh after cached startup load.
- [x] Preserve old cache when refresh fails.
- [x] Store profile sync status, last sync time, last sync message, and unread count.
- [x] Add cache repository and adapter fallback tests.
- [x] Run `npm run test`.
- [x] Run `npm run build`.

## Phase 4: Reliability Polish

- Add sync run history.
- Add better Chinese error mapping.
- Add retry-safe sync behavior.
- Add packaging configuration.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| ClawEmail profile discovery behavior is not yet confirmed | High | Keep discovery behind `clawCliAdapter` and stabilize with mock data first. |
| auth-url exposure through logs or shell history | High | Never use shell strings, redact diagnostics, and keep auth-url only in memory. |
| Native SQLite packaging complexity | Medium | Isolate persistence behind a repository layer before packaging work. |
| mail-cli output format changes | Medium | Validate external command output at the adapter boundary. |

## Open Questions

- What exact `mail-cli` commands list profiles, refresh inboxes, and fetch message bodies?
- Where does ClawEmail store initialized profiles on each operating system?
- What fields does ClawEmail expose for read/unread and attachment presence?
