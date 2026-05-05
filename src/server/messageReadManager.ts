import type { ClawCliAdapter } from '../main/clawCliAdapter';
import type { MailDetail } from '../shared/types';

export class MessageReadManager {
  private readonly inFlight = new Map<string, Promise<MailDetail>>();

  constructor(private readonly adapter: ClawCliAdapter) {}

  getMessage(messageId: string): Promise<MailDetail> {
    const running = this.inFlight.get(messageId);
    if (running) return running;

    const promise = this.adapter.getMessage(messageId);
    this.inFlight.set(messageId, promise);
    return promise.finally(() => {
      this.inFlight.delete(messageId);
    });
  }
}
