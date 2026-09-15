import { type Role } from '../common/enums/role.enum';

/** The authenticated caller, resolved from a verified access token and a live session. */
export interface AuthenticatedUser {
  readonly id: number;
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly role: Role;
  readonly sessionId: string;
  readonly mustChangePassword: boolean;
}

export const TokenType = {
  ACCESS: 'access',
  REFRESH: 'refresh',
} as const;

export type TokenType = (typeof TokenType)[keyof typeof TokenType];

/** Access-token claims. Contains no secrets: identifiers and display data only. */
export interface AccessTokenPayload {
  readonly sub: number;
  readonly userId: number;
  readonly name: string;
  readonly role: Role;
  readonly phone: string;
  readonly type: typeof TokenType.ACCESS;
  /** Session (refresh-token family) id; revoking the session invalidates the token. */
  readonly sid: string;
}

export interface RefreshTokenPayload {
  readonly sub: number;
  readonly type: typeof TokenType.REFRESH;
  readonly sid: string;
  /** Refresh token row id. */
  readonly jti: string;
}

export interface TokenPair {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
}
