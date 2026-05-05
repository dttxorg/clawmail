import { describe, expect, it } from 'vitest';
import { ClawImapAdapter, type ImapClientLike } from './imapAdapter';
import type { MailboxProfile } from '../shared/types';

describe('ClawImapAdapter', () => {
  it('prefers HTML bodies and keeps text fallback for snippets', async () => {
    const adapter = new ClawImapAdapter(() => createFakeClient());
    const detail = await adapter.getMessage(
      profile,
      {
        profileId: profile.id,
        email: profile.emailAddress,
        password: 'AUTH_CODE',
        host: 'claw.163.com',
        port: 993,
        secure: true
      },
      '42'
    );

    expect(detail.bodyHtml).toContain('<strong>ClawInbox</strong>');
    expect(detail.bodyText).toContain('Hello ClawInbox');
    expect(detail.snippet).toContain('Hello ClawInbox');
  });
});

const profile: MailboxProfile = {
  id: 'agent@claw.163.com',
  profileName: 'agent',
  emailAddress: 'agent@claw.163.com',
  displayName: 'agent@claw.163.com',
  imapHost: 'claw.163.com',
  imapPort: 993,
  status: 'READY',
  lastSyncAt: null,
  unreadCount: 0
};

function createFakeClient(): ImapClientLike {
  return {
    async connect() {},
    async logout() {},
    async getMailboxLock() {
      return { release() {} };
    },
    async status() {
      return { unseen: 0, messages: 1 };
    },
    async search() {
      return [42];
    },
    async fetchAll() {
      return [];
    },
    async fetchOne() {
      return {
        uid: 42,
        flags: new Set(),
        internalDate: new Date('2026-04-30T10:00:00.000Z'),
        envelope: {
          subject: 'HTML mail',
          from: [{ name: 'Sender', address: 'sender@example.com' }]
        },
        source:
          'From: Sender <sender@example.com>\r\n' +
          'Subject: HTML mail\r\n' +
          'Content-Type: text/html; charset=utf-8\r\n' +
          '\r\n' +
          '<p>Hello <strong>ClawInbox</strong></p>'
      } as never;
    }
  };
}
