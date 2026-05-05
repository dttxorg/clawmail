import { describe, expect, it, vi } from 'vitest';
import { MessageReadManager } from './messageReadManager';
import type { ClawCliAdapter } from '../main/clawCliAdapter';
import type { MailDetail } from '../shared/types';

describe('MessageReadManager', () => {
  it('shares concurrent reads for the same message', async () => {
    const detail: MailDetail = {
      id: 'profile-1:1',
      profileId: 'profile-1',
      fromName: 'Sender',
      fromAddress: 'sender@example.com',
      subject: 'Subject',
      receivedAt: '2026-05-06T00:00:00.000Z',
      isRead: false,
      hasAttachments: false,
      snippet: 'Subject',
      bodyText: 'Body'
    };
    const adapter = {
      getMessage: vi.fn(async () => detail)
    } as unknown as ClawCliAdapter;
    const manager = new MessageReadManager(adapter);

    await Promise.all([
      manager.getMessage(detail.id),
      manager.getMessage(detail.id),
      manager.getMessage(detail.id)
    ]);

    expect(adapter.getMessage).toHaveBeenCalledTimes(1);
  });
});
