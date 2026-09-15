import { type AppLogger } from '../common/logger/logger';
import { type PasswordResetTokenRepository } from './repositories/password-reset-token.repository';
import { type RefreshTokenRepository } from './repositories/refresh-token.repository';
import { TokenCleanupService } from './token-cleanup.service';

const NOW = new Date('2026-09-11T00:00:00Z');

function setup() {
  const refresh = {
    deleteExpiredBefore: jest.fn().mockResolvedValue(3),
  } as unknown as jest.Mocked<RefreshTokenRepository>;
  const reset = {
    deleteExpiredBefore: jest.fn().mockResolvedValue(1),
  } as unknown as jest.Mocked<PasswordResetTokenRepository>;
  const logger = { info: jest.fn(), error: jest.fn() } as unknown as jest.Mocked<AppLogger>;
  return {
    service: new TokenCleanupService(refresh, reset, { now: () => NOW }, logger),
    refresh,
    reset,
    logger,
  };
}

describe('TokenCleanupService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('deletes tokens that expired more than 30 days ago', async () => {
    const { service, refresh, reset } = setup();
    await expect(service.purgeExpired()).resolves.toEqual({ refreshTokens: 3, resetTokens: 1 });
    const cutoff = new Date('2026-08-12T00:00:00Z');
    expect(refresh.deleteExpiredBefore).toHaveBeenCalledWith(cutoff);
    expect(reset.deleteExpiredBefore).toHaveBeenCalledWith(cutoff);
  });

  it('runs immediately and on an interval until stopped, logging failures', async () => {
    jest.useFakeTimers();
    const { service, refresh, logger } = setup();
    refresh.deleteExpiredBefore.mockRejectedValueOnce(new Error('db down'));

    service.start(1000);
    service.start(1000); // idempotent
    await jest.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(2000);
    expect(refresh.deleteExpiredBefore).toHaveBeenCalledTimes(3);

    service.stop();
    await jest.advanceTimersByTimeAsync(5000);
    expect(refresh.deleteExpiredBefore).toHaveBeenCalledTimes(3);
  });
});
