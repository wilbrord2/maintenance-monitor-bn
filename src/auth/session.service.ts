import { randomUUID } from 'node:crypto';
import { type EntityManager } from 'typeorm';
import { AuditAction, AuditEntity } from '../audit/audit.constants';
import { type AuditService } from '../audit/audit.service';
import { type TransactionRunner } from '../common/database/transaction-runner';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { type RequestMeta } from '../common/http/request-meta';
import { type Clock } from '../common/utils/clock';
import { constantTimeEqualHex, sha256Hex } from '../common/utils/crypto';
import { type User } from '../users/user.entity';
import { type UsersRepository } from '../users/users.repository';
import { type AuthenticatedUser, type TokenPair } from './auth.types';
import { SessionRevocationReason } from './entities/refresh-token.entity';
import { type RefreshTokenRepository } from './repositories/refresh-token.repository';
import { type TokenService } from './token.service';

export interface SessionIssue {
  readonly user: User;
  readonly tokens: TokenPair;
}

/**
 * Owns the refresh-token lifecycle: issuing sessions, rotation with reuse
 * detection, revocation, and resolving access tokens to live sessions.
 */
export class SessionService {
  constructor(
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly users: UsersRepository,
    private readonly tokens: TokenService,
    private readonly transactions: TransactionRunner,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** Starts a new session (token family) for the user. */
  async startSession(user: User, meta: RequestMeta, manager?: EntityManager): Promise<TokenPair> {
    return this.issueTokens(user, randomUUID(), meta, manager);
  }

  /**
   * Exchanges a refresh token for a new pair. The presented token is revoked;
   * presenting an already-rotated token revokes the whole family (likely theft).
   */
  async rotate(refreshToken: string, meta: RequestMeta): Promise<SessionIssue> {
    const claims = this.tokens.verifyRefreshToken(refreshToken);
    const now = this.clock.now();

    const outcome = await this.transactions.run(async (manager) => {
      const stored = await this.refreshTokens.findByIdForUpdate(claims.jti, manager);
      if (!stored) throw AppError.unauthorized('Refresh token is invalid', ErrorCode.TOKEN_INVALID);
      const matches =
        stored.userId === claims.sub &&
        stored.familyId === claims.sid &&
        constantTimeEqualHex(stored.tokenHash, sha256Hex(refreshToken));
      if (!matches) throw AppError.unauthorized('Refresh token is invalid', ErrorCode.TOKEN_INVALID);

      if (stored.revokedAt) {
        if (stored.revokedReason === SessionRevocationReason.ROTATED) {
          await this.refreshTokens.revokeFamily(
            stored.familyId,
            SessionRevocationReason.REUSE_DETECTED,
            now,
            manager,
          );
          await this.audit.record(
            {
              action: AuditAction.TOKEN_REUSE_DETECTED,
              entity: AuditEntity.AUTH,
              entityId: stored.userId,
              actorId: stored.userId,
              newValues: { sessionId: stored.familyId },
              meta,
            },
            manager,
          );
          return { kind: 'reuse' as const };
        }
        throw AppError.unauthorized('Refresh token has been revoked', ErrorCode.TOKEN_REVOKED);
      }

      if (stored.expiresAt <= now) {
        throw AppError.unauthorized('Refresh token has expired', ErrorCode.TOKEN_EXPIRED);
      }

      const user = await this.users.findById(stored.userId, manager);
      if (!user?.isActive) {
        await this.refreshTokens.revokeFamily(
          stored.familyId,
          SessionRevocationReason.USER_DEACTIVATED,
          now,
          manager,
        );
        return { kind: 'inactive' as const };
      }

      const tokens = await this.issueTokens(user, stored.familyId, meta, manager, stored.id);
      return { kind: 'rotated' as const, user, tokens };
    });

    // Revocations above must commit, so the rejection is raised after the transaction.
    if (outcome.kind === 'reuse') {
      throw AppError.unauthorized('Refresh token has been revoked', ErrorCode.TOKEN_REVOKED);
    }
    if (outcome.kind === 'inactive') {
      throw AppError.unauthorized('Session is no longer valid', ErrorCode.TOKEN_REVOKED);
    }
    return { user: outcome.user, tokens: outcome.tokens };
  }

  async revokeSession(
    sessionId: string,
    reason: SessionRevocationReason,
    manager?: EntityManager,
  ): Promise<void> {
    await this.refreshTokens.revokeFamily(sessionId, reason, this.clock.now(), manager);
  }

  async revokeAllSessions(
    userId: number,
    reason: SessionRevocationReason,
    manager?: EntityManager,
  ): Promise<void> {
    await this.refreshTokens.revokeAllForUser(userId, reason, this.clock.now(), manager);
  }

  /** Verifies an access token and confirms its user and session are still valid. */
  async authenticate(accessToken: string): Promise<AuthenticatedUser> {
    return (await this.authenticateWithExpiry(accessToken)).user;
  }

  async authenticateWithExpiry(accessToken: string): Promise<{ user: AuthenticatedUser; expiresAt: Date }> {
    const { claims, expiresAt } = this.tokens.verifyAccessTokenWithExpiry(accessToken);
    const user = await this.refreshTokens.findUserWithActiveSession(claims.sub, claims.sid, this.clock.now());
    if (!user) throw AppError.unauthorized('Session is no longer valid', ErrorCode.TOKEN_REVOKED);
    return {
      expiresAt,
      user: {
        id: user.id,
        name: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        sessionId: claims.sid,
        mustChangePassword: user.mustChangePassword,
      },
    };
  }

  private async issueTokens(
    user: User,
    familyId: string,
    meta: RequestMeta,
    manager: EntityManager | undefined,
    rotatedFromId?: string,
  ): Promise<TokenPair> {
    const tokenId = randomUUID();
    const refresh = this.tokens.signRefreshToken({ sub: user.id, sid: familyId, jti: tokenId });
    const access = this.tokens.signAccessToken({
      sub: user.id,
      userId: user.id,
      name: user.fullName,
      role: user.role,
      phone: user.phone,
      sid: familyId,
    });

    await this.refreshTokens.insert(
      {
        id: tokenId,
        userId: user.id,
        familyId,
        tokenHash: sha256Hex(refresh.token),
        expiresAt: refresh.expiresAt,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
      manager,
    );
    if (rotatedFromId && manager) {
      await this.refreshTokens.markRotated(rotatedFromId, tokenId, this.clock.now(), manager);
    }

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.expiresAt,
    };
  }
}
