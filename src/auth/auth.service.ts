import { AuditAction, AuditEntity } from '../audit/audit.constants';
import { type AuditService } from '../audit/audit.service';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { type RequestMeta } from '../common/http/request-meta';
import { type Clock } from '../common/utils/clock';
import { type AppConfig } from '../config/config';
import { type User } from '../users/user.entity';
import { type UsersRepository } from '../users/users.repository';
import { type AuthenticatedUser, type TokenPair } from './auth.types';
import { SessionRevocationReason } from './entities/refresh-token.entity';
import { type PasswordHasher } from './password-hasher';
import { type SessionService } from './session.service';

export interface LoginResult {
  readonly user: User;
  readonly tokens: TokenPair;
  readonly mustChangePassword: boolean;
}

type LoginFailureReason =
  'UNKNOWN_EMAIL' | 'INVALID_PASSWORD' | 'ACCOUNT_LOCKED' | 'ACCOUNT_INACTIVE' | 'TEMPORARY_PASSWORD_EXPIRED';

const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';

export class AuthService {
  constructor(
    private readonly users: UsersRepository,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly policy: AppConfig['auth'],
    private readonly clock: Clock,
  ) {}

  async login(email: string, password: string, meta: RequestMeta): Promise<LoginResult> {
    const now = this.clock.now();
    const user = await this.users.findByEmail(email);

    if (!user) {
      await this.hasher.verifyDummy(password);
      await this.recordFailure(null, email, 'UNKNOWN_EMAIL', meta);
      throw AppError.unauthorized(INVALID_CREDENTIALS_MESSAGE, ErrorCode.INVALID_CREDENTIALS);
    }

    if (user.lockedUntil && user.lockedUntil > now) {
      await this.recordFailure(user.id, email, 'ACCOUNT_LOCKED', meta);
      throw new AppError(
        423,
        ErrorCode.ACCOUNT_LOCKED,
        'Account is temporarily locked. Please try again later.',
      );
    }

    const passwordValid = await this.hasher.verify(user.passwordHash, password);
    if (!passwordValid) {
      const result = await this.users.registerFailedLogin(
        user.id,
        this.policy.maxLoginAttempts,
        this.policy.lockoutMinutes,
      );
      await this.recordFailure(user.id, email, 'INVALID_PASSWORD', meta);
      if (result.lockedUntil && result.lockedUntil > now) {
        await this.audit.record({
          action: AuditAction.ACCOUNT_LOCKED,
          entity: AuditEntity.USER,
          entityId: user.id,
          actorId: user.id,
          newValues: { lockedUntil: result.lockedUntil },
          meta,
        });
      }
      throw AppError.unauthorized(INVALID_CREDENTIALS_MESSAGE, ErrorCode.INVALID_CREDENTIALS);
    }

    // Account state is only disclosed to callers who proved knowledge of the password.
    if (!user.isActive) {
      await this.recordFailure(user.id, email, 'ACCOUNT_INACTIVE', meta);
      throw AppError.forbidden('This account has been deactivated', ErrorCode.USER_INACTIVE);
    }
    if (user.mustChangePassword && user.passwordExpiresAt && user.passwordExpiresAt <= now) {
      await this.recordFailure(user.id, email, 'TEMPORARY_PASSWORD_EXPIRED', meta);
      throw AppError.unauthorized(
        'Your temporary password has expired. Ask an administrator to issue a new one.',
        ErrorCode.TEMPORARY_PASSWORD_EXPIRED,
      );
    }

    if (this.hasher.needsRehash(user.passwordHash)) {
      await this.users.updatePasswordHash(user.id, await this.hasher.hash(password));
    }
    await this.users.registerSuccessfulLogin(user.id, now);
    const tokens = await this.sessions.startSession(user, meta);

    await this.audit.record({
      action: AuditAction.LOGIN_SUCCEEDED,
      entity: AuditEntity.AUTH,
      entityId: user.id,
      actorId: user.id,
      newValues: { mustChangePassword: user.mustChangePassword },
      meta,
    });

    user.lastLoginAt = now;
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    return { user, tokens, mustChangePassword: user.mustChangePassword };
  }

  refresh(refreshToken: string, meta: RequestMeta) {
    return this.sessions.rotate(refreshToken, meta);
  }

  async logout(principal: AuthenticatedUser, meta: RequestMeta): Promise<void> {
    await this.sessions.revokeSession(principal.sessionId, SessionRevocationReason.LOGOUT);
    await this.audit.record({
      action: AuditAction.LOGOUT,
      entity: AuditEntity.AUTH,
      entityId: principal.id,
      actorId: principal.id,
      meta,
    });
  }

  authenticate(accessToken: string): Promise<AuthenticatedUser> {
    return this.sessions.authenticate(accessToken);
  }

  private async recordFailure(
    userId: number | null,
    email: string,
    reason: LoginFailureReason,
    meta: RequestMeta,
  ): Promise<void> {
    await this.audit.record({
      action: AuditAction.LOGIN_FAILED,
      entity: AuditEntity.AUTH,
      entityId: userId,
      actorId: userId,
      newValues: { email: email.slice(0, 254), reason },
      meta,
    });
  }
}
