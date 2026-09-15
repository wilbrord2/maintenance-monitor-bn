import { type AppLogger } from '../common/logger/logger';
import { type Clock } from '../common/utils/clock';
import { type PasswordResetTokenRepository } from './repositories/password-reset-token.repository';
import { type RefreshTokenRepository } from './repositories/refresh-token.repository';

/** Expired credentials are kept this long for incident investigation before being purged. */
export const TOKEN_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Purges long-expired refresh and password-reset tokens. Deletion is
 * idempotent, so running it on several replicas at once is harmless.
 */
export class TokenCleanupService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly resetTokens: PasswordResetTokenRepository,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
  ) {}

  async purgeExpired(): Promise<{ refreshTokens: number; resetTokens: number }> {
    const cutoff = new Date(this.clock.now().getTime() - TOKEN_RETENTION_DAYS * DAY_MS);
    const [refreshTokens, resetTokens] = await Promise.all([
      this.refreshTokens.deleteExpiredBefore(cutoff),
      this.resetTokens.deleteExpiredBefore(cutoff),
    ]);
    if (refreshTokens + resetTokens > 0) {
      this.logger.info({ refreshTokens, resetTokens }, 'Purged expired authentication tokens');
    }
    return { refreshTokens, resetTokens };
  }

  start(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (this.timer) return;
    const run = () => {
      this.purgeExpired().catch((error: unknown) => {
        this.logger.error({ err: error }, 'Token cleanup failed');
      });
    };
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
    run();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
