import { AuditAction, AuditEntity } from '../audit/audit.constants';
import { type AuditService } from '../audit/audit.service';
import { type TransactionRunner } from '../common/database/transaction-runner';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { type RequestMeta } from '../common/http/request-meta';
import { type AppLogger } from '../common/logger/logger';
import { addMinutes, type Clock } from '../common/utils/clock';
import { generateSecureToken, sha256Hex } from '../common/utils/crypto';
import { type AppConfig } from '../config/config';
import { type MailService } from '../notifications/mail/mail.service';
import { type User } from '../users/user.entity';
import { type UsersRepository } from '../users/users.repository';
import { type AuthenticatedUser, type TokenPair } from './auth.types';
import { SessionRevocationReason } from './entities/refresh-token.entity';
import { type PasswordHasher } from './password-hasher';
import { type PasswordResetTokenRepository } from './repositories/password-reset-token.repository';
import { type SessionService } from './session.service';

export interface PasswordChangeResult {
  readonly user: User;
  readonly tokens: TokenPair;
}

const INVALID_RESET_TOKEN_MESSAGE = 'This password reset link is invalid or has expired';

export class PasswordService {
  constructor(
    private readonly users: UsersRepository,
    private readonly resetTokens: PasswordResetTokenRepository,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionService,
    private readonly transactions: TransactionRunner,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly policy: AppConfig['auth'],
    private readonly clock: Clock,
    private readonly logger: AppLogger,
  ) {}

  /**
   * Changes the caller's password. Completes onboarding for temporary
   * credentials, revokes every existing session and starts a fresh one.
   */
  async changePassword(
    principal: AuthenticatedUser,
    currentPassword: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<PasswordChangeResult> {
    const user = await this.users.findById(principal.id);
    if (!user?.isActive) throw AppError.unauthorized('Session is no longer valid', ErrorCode.TOKEN_REVOKED);

    if (!(await this.hasher.verify(user.passwordHash, currentPassword))) {
      await this.users.registerFailedLogin(user.id, this.policy.maxLoginAttempts, this.policy.lockoutMinutes);
      throw AppError.unprocessable('Current password is incorrect', ErrorCode.INVALID_CREDENTIALS);
    }
    if (await this.hasher.verify(user.passwordHash, newPassword)) {
      throw AppError.unprocessable(
        'The new password must differ from the current password',
        ErrorCode.PASSWORD_REUSE,
      );
    }

    const wasOnboarding = user.mustChangePassword;
    const passwordHash = await this.hasher.hash(newPassword);
    const now = this.clock.now();

    const tokens = await this.transactions.run(async (manager) => {
      const locked = await this.users.findByIdForUpdate(user.id, manager);
      if (!locked?.isActive)
        throw AppError.unauthorized('Session is no longer valid', ErrorCode.TOKEN_REVOKED);
      this.applyNewPassword(locked, passwordHash, now);
      await this.users.save(locked, manager);
      Object.assign(user, locked);

      await this.sessions.revokeAllSessions(user.id, SessionRevocationReason.PASSWORD_CHANGED, manager);
      await this.audit.record(
        {
          action: AuditAction.PASSWORD_CHANGED,
          entity: AuditEntity.USER,
          entityId: user.id,
          actorId: user.id,
          newValues: { completedOnboarding: wasOnboarding },
          meta,
        },
        manager,
      );
      return this.sessions.startSession(locked, meta, manager);
    });

    if (!wasOnboarding) {
      this.dispatch(
        this.mail.sendPasswordChanged({ to: user.email, fullName: user.fullName, changedAt: now }),
      );
    }
    return { user, tokens };
  }

  /**
   * Issues a single-use reset token when an active account exists. Always
   * resolves identically so callers cannot discover registered emails.
   */
  async requestPasswordReset(email: string, meta: RequestMeta): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user?.isActive) return;

    const rawToken = generateSecureToken(32);
    const now = this.clock.now();
    await this.transactions.run(async (manager) => {
      await this.resetTokens.invalidateOutstanding(user.id, now, manager);
      await this.resetTokens.insert(
        {
          userId: user.id,
          tokenHash: sha256Hex(rawToken),
          expiresAt: addMinutes(now, this.policy.passwordResetTtlMinutes),
          ipAddress: meta.ipAddress,
        },
        manager,
      );
      await this.audit.record(
        {
          action: AuditAction.PASSWORD_RESET_REQUESTED,
          entity: AuditEntity.USER,
          entityId: user.id,
          actorId: null,
          meta,
        },
        manager,
      );
    });

    const resetUrl = new URL(this.policy.passwordResetUrl);
    resetUrl.searchParams.set('token', rawToken);
    // Delivery is not awaited so response timing does not reveal whether the account exists.
    this.dispatch(
      this.mail.sendPasswordReset({
        to: user.email,
        fullName: user.fullName,
        resetUrl: resetUrl.toString(),
        expiresInMinutes: this.policy.passwordResetTtlMinutes,
      }),
    );
  }

  /** Consumes a reset token, sets the new password and signs the user out everywhere. */
  async resetPassword(rawToken: string, newPassword: string, meta: RequestMeta): Promise<void> {
    const passwordHash = await this.hasher.hash(newPassword);
    const now = this.clock.now();

    const user = await this.transactions.run(async (manager) => {
      const token = await this.resetTokens.findByHashForUpdate(sha256Hex(rawToken), manager);
      if (!token || token.usedAt || token.expiresAt <= now) {
        throw AppError.badRequest(INVALID_RESET_TOKEN_MESSAGE, ErrorCode.INVALID_RESET_TOKEN);
      }
      const account = await this.users.findByIdForUpdate(token.userId, manager);
      if (!account?.isActive) {
        throw AppError.badRequest(INVALID_RESET_TOKEN_MESSAGE, ErrorCode.INVALID_RESET_TOKEN);
      }

      await this.resetTokens.invalidateOutstanding(account.id, now, manager);
      this.applyNewPassword(account, passwordHash, now);
      await this.users.save(account, manager);
      await this.sessions.revokeAllSessions(account.id, SessionRevocationReason.PASSWORD_RESET, manager);
      await this.audit.record(
        {
          action: AuditAction.PASSWORD_RESET_COMPLETED,
          entity: AuditEntity.USER,
          entityId: account.id,
          actorId: account.id,
          meta,
        },
        manager,
      );
      return account;
    });

    this.dispatch(this.mail.sendPasswordChanged({ to: user.email, fullName: user.fullName, changedAt: now }));
  }

  private applyNewPassword(user: User, passwordHash: string, now: Date): void {
    user.passwordHash = passwordHash;
    user.mustChangePassword = false;
    user.passwordExpiresAt = null;
    user.passwordChangedAt = now;
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
  }

  /** Fire-and-forget email; failures are logged by MailService and never surface to the caller. */
  private dispatch(delivery: Promise<void>): void {
    delivery.catch(() => {
      this.logger.warn('Notification email could not be delivered');
    });
  }
}
