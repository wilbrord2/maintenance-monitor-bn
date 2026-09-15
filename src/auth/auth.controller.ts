import { type Request, type Response } from 'express';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { type HttpResult, ok } from '../common/http/response';
import { type AuthenticatedRequestInput, type RequestInput } from '../common/http/route';
import { API_PREFIX } from '../common/openapi/openapi';
import { type AppConfig } from '../config/config';
import { type User } from '../users/user.entity';
import { toUserResponse } from '../users/user.mapper';
import {
  type ChangePasswordDto,
  type ForgotPasswordDto,
  type LoginDto,
  type RefreshDto,
  type ResetPasswordDto,
} from './auth.dto';
import { type AuthService } from './auth.service';
import { type TokenPair } from './auth.types';
import { type PasswordService } from './password.service';

type Ctx<B> = RequestInput<undefined, undefined, B>;
type ProtectedCtx<B> = AuthenticatedRequestInput<undefined, undefined, B>;

const REFRESH_COOKIE_PATH = `${API_PREFIX}/auth`;

export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly passwords: PasswordService,
    private readonly settings: AppConfig['auth'],
  ) {}

  async login({ body, meta, res }: Ctx<LoginDto>): Promise<HttpResult> {
    const result = await this.auth.login(body.email, body.password, meta);
    this.setRefreshCookie(res, result.tokens);
    return ok(
      result.mustChangePassword
        ? 'Login successful. You must change your password to continue.'
        : 'Login successful',
      this.session(result.user, result.tokens),
    );
  }

  async refresh({ body, meta, req, res }: Ctx<RefreshDto>): Promise<HttpResult> {
    const refreshToken = body.refreshToken ?? this.readRefreshCookie(req);
    if (!refreshToken) throw AppError.unauthorized('Refresh token is required', ErrorCode.TOKEN_INVALID);
    try {
      const { user, tokens } = await this.auth.refresh(refreshToken, meta);
      this.setRefreshCookie(res, tokens);
      return ok('Token refreshed', this.session(user, tokens));
    } catch (error: unknown) {
      this.clearRefreshCookie(res);
      throw error;
    }
  }

  async logout({ user, meta, res }: ProtectedCtx<undefined>): Promise<HttpResult> {
    await this.auth.logout(user, meta);
    this.clearRefreshCookie(res);
    return ok('Logged out');
  }

  async changePassword({ user, body, meta, res }: ProtectedCtx<ChangePasswordDto>): Promise<HttpResult> {
    const result = await this.passwords.changePassword(user, body.currentPassword, body.newPassword, meta);
    this.setRefreshCookie(res, result.tokens);
    return ok(
      'Password changed successfully. Other sessions have been signed out.',
      this.session(result.user, result.tokens),
    );
  }

  async forgotPassword({ body, meta }: Ctx<ForgotPasswordDto>): Promise<HttpResult> {
    await this.passwords.requestPasswordReset(body.email, meta);
    return ok('If an account exists for that email, a password reset link has been sent.');
  }

  async resetPassword({ body, meta, res }: Ctx<ResetPasswordDto>): Promise<HttpResult> {
    await this.passwords.resetPassword(body.token, body.newPassword, meta);
    this.clearRefreshCookie(res);
    return ok('Your password has been reset. Please log in with your new password.');
  }

  private session(user: User, tokens: TokenPair) {
    return {
      user: toUserResponse(user),
      mustChangePassword: user.mustChangePassword,
      tokens: {
        tokenType: 'Bearer' as const,
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
        refreshToken: tokens.refreshToken,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
      },
    };
  }

  private readRefreshCookie(req: Request): string | undefined {
    const cookies: unknown = req.cookies;
    if (typeof cookies !== 'object' || cookies === null) return undefined;
    const value = (cookies as Record<string, unknown>)[this.settings.refreshCookieName];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private setRefreshCookie(res: Response, tokens: TokenPair): void {
    res.cookie(this.settings.refreshCookieName, tokens.refreshToken, {
      httpOnly: true,
      secure: this.settings.cookieSecure,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      expires: tokens.refreshTokenExpiresAt,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(this.settings.refreshCookieName, {
      httpOnly: true,
      secure: this.settings.cookieSecure,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
    });
  }
}
