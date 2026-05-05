import type { ClawCliAdapter } from '../main/clawCliAdapter';
import type { SyncResult } from '../shared/types';

export interface ManagedRefreshResult {
  result: SyncResult;
  skipped: boolean;
  reason: 'REFRESHED' | 'IN_FLIGHT' | 'COOLDOWN';
}

export class RefreshManager {
  private readonly inFlight = new Map<string, Promise<ManagedRefreshResult>>();
  private readonly lastFinishedAt = new Map<string, number>();

  constructor(
    private readonly adapter: ClawCliAdapter,
    private readonly cooldownMs = 60_000
  ) {}

  refreshProfile(profileId: string, options: { force?: boolean } = {}): Promise<ManagedRefreshResult> {
    const running = this.inFlight.get(profileId);
    if (running) return running.then((value) => ({ ...value, reason: 'IN_FLIGHT' }));

    const elapsed = Date.now() - (this.lastFinishedAt.get(profileId) ?? 0);
    if (!options.force && elapsed < this.cooldownMs) {
      return Promise.resolve({
        skipped: true,
        reason: 'COOLDOWN',
        result: {
          ok: true,
          profileId,
          syncedAt: new Date().toISOString(),
          message: `刚刚刷新过，${Math.ceil((this.cooldownMs - elapsed) / 1000)} 秒后可再次刷新。`
        }
      });
    }

    const promise = this.adapter.refreshProfile(profileId).then((result) => {
      this.lastFinishedAt.set(profileId, Date.now());
      return { result, skipped: false, reason: 'REFRESHED' as const };
    });
    this.inFlight.set(profileId, promise);
    return promise.finally(() => {
      this.inFlight.delete(profileId);
    });
  }
}
