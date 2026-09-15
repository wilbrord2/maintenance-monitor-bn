import jwt, { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import { z } from 'zod';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { Role } from '../common/enums/role.enum';
import { addSeconds, type Clock } from '../common/utils/clock';
import { type AppConfig } from '../config/config';
import { type AccessTokenPayload, type RefreshTokenPayload, TokenType } from './auth.types';

const ALGORITHM = 'HS256';

const accessClaimsSchema = z.object({
  sub: z.number().int().positive(),
  userId: z.number().int().positive(),
  name: z.string(),
  role: z.enum(Role),
  phone: z.string(),
  type: z.literal(TokenType.ACCESS),
  sid: z.uuid(),
});

const expiryClaimSchema = z.object({ exp: z.number().int().positive() });

const refreshClaimsSchema = z.object({
  sub: z.number().int().positive(),
  type: z.literal(TokenType.REFRESH),
  sid: z.uuid(),
  jti: z.uuid(),
});

export interface SignedToken {
  readonly token: string;
  readonly expiresAt: Date;
}

/** Signs and verifies JWTs. Access and refresh tokens use separate secrets and a `type` claim. */
export class TokenService {
  constructor(
    private readonly settings: AppConfig['jwt'],
    private readonly clock: Clock,
  ) {}

  signAccessToken(payload: Omit<AccessTokenPayload, 'type'>): SignedToken {
    const claims: AccessTokenPayload = { ...payload, type: TokenType.ACCESS };
    return this.sign(claims, this.settings.accessSecret, this.settings.accessTtlSeconds);
  }

  signRefreshToken(payload: Omit<RefreshTokenPayload, 'type'>): SignedToken {
    const claims: RefreshTokenPayload = { ...payload, type: TokenType.REFRESH };
    return this.sign(claims, this.settings.refreshSecret, this.settings.refreshTtlSeconds);
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    return this.verify(token, this.settings.accessSecret, accessClaimsSchema);
  }

  /** Verifies an access token and also returns its expiry (used to bound long-lived connections). */
  verifyAccessTokenWithExpiry(token: string): { claims: AccessTokenPayload; expiresAt: Date } {
    const claims = this.verify(
      token,
      this.settings.accessSecret,
      accessClaimsSchema.extend(expiryClaimSchema.shape),
    );
    const { exp, ...rest } = claims;
    return { claims: rest, expiresAt: new Date(exp * 1000) };
  }

  verifyRefreshToken(token: string): RefreshTokenPayload {
    return this.verify(token, this.settings.refreshSecret, refreshClaimsSchema);
  }

  get refreshTtlSeconds(): number {
    return this.settings.refreshTtlSeconds;
  }

  private sign(claims: object, secret: string, ttlSeconds: number): SignedToken {
    const issuedAt = this.clock.now();
    const token = jwt.sign({ ...claims, iat: Math.floor(issuedAt.getTime() / 1000) }, secret, {
      algorithm: ALGORITHM,
      expiresIn: ttlSeconds,
      issuer: this.settings.issuer,
      audience: this.settings.audience,
    });
    return { token, expiresAt: addSeconds(issuedAt, ttlSeconds) };
  }

  private verify<T>(token: string, secret: string, schema: z.ZodType<T>): T {
    let decoded: unknown;
    try {
      decoded = jwt.verify(token, secret, {
        algorithms: [ALGORITHM],
        issuer: this.settings.issuer,
        audience: this.settings.audience,
        clockTimestamp: Math.floor(this.clock.now().getTime() / 1000),
      });
    } catch (error: unknown) {
      if (error instanceof TokenExpiredError) {
        throw AppError.unauthorized('Token has expired', ErrorCode.TOKEN_EXPIRED);
      }
      if (error instanceof JsonWebTokenError) {
        throw AppError.unauthorized('Token is invalid', ErrorCode.TOKEN_INVALID);
      }
      throw error;
    }
    const parsed = schema.safeParse(decoded);
    if (!parsed.success) throw AppError.unauthorized('Token is invalid', ErrorCode.TOKEN_INVALID);
    return parsed.data;
  }
}
