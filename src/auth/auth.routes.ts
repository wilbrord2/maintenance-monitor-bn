import { ROLES } from '../common/enums/role.enum';
import { type RateLimiters } from '../common/middleware/rate-limit.middleware';
import { protectedRoute, publicRoute, type RouteDefinition } from '../common/http/route';
import { type AuthController } from './auth.controller';
import {
  authSessionResponseSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  resetPasswordSchema,
} from './auth.dto';

const TAGS = ['Auth'];

export function authRoutes(controller: AuthController, limiters: RateLimiters): RouteDefinition[] {
  return [
    publicRoute({
      method: 'post',
      path: '/auth/login',
      tags: TAGS,
      summary: 'Log in with email and password',
      description:
        'Returns an access token and a refresh token (also set as an httpOnly cookie scoped to /api/v1/auth). ' +
        'Accounts lock after repeated failures. When `mustChangePassword` is true, only change-password, ' +
        'logout and the own-profile endpoints are accessible.',
      body: loginSchema,
      middleware: [limiters.authPerIp, limiters.login],
      response: { status: 200, description: 'Authenticated session', data: authSessionResponseSchema },
      errors: [401, 403, 423],
      handler: (ctx) => controller.login(ctx),
    }),
    publicRoute({
      method: 'post',
      path: '/auth/refresh',
      tags: TAGS,
      summary: 'Rotate the refresh token and obtain a new access token',
      description:
        'The presented refresh token is revoked and replaced. Re-using a rotated token revokes the entire session.',
      body: refreshSchema,
      middleware: [limiters.authPerIp],
      response: { status: 200, description: 'New token pair', data: authSessionResponseSchema },
      handler: (ctx) => controller.refresh(ctx),
    }),
    protectedRoute({
      method: 'post',
      path: '/auth/logout',
      tags: TAGS,
      summary: 'Log out and revoke the current session',
      roles: ROLES,
      allowPendingPasswordChange: true,
      response: { status: 200, description: 'Session revoked' },
      handler: (ctx) => controller.logout(ctx),
    }),
    protectedRoute({
      method: 'post',
      path: '/auth/change-password',
      tags: TAGS,
      summary: 'Change the current password',
      description:
        'Completes first-time onboarding for temporary credentials. Revokes all sessions and returns a fresh token pair.',
      roles: ROLES,
      allowPendingPasswordChange: true,
      body: changePasswordSchema,
      middleware: [limiters.sensitive],
      response: {
        status: 200,
        description: 'Password changed; new session issued',
        data: authSessionResponseSchema,
      },
      errors: [422],
      handler: (ctx) => controller.changePassword(ctx),
    }),
    publicRoute({
      method: 'post',
      path: '/auth/forgot-password',
      tags: TAGS,
      summary: 'Request a password reset email',
      description: 'Always returns the same response whether or not the email is registered.',
      body: forgotPasswordSchema,
      middleware: [limiters.passwordRecovery],
      response: { status: 200, description: 'Generic acknowledgement' },
      handler: (ctx) => controller.forgotPassword(ctx),
    }),
    publicRoute({
      method: 'post',
      path: '/auth/reset-password',
      tags: TAGS,
      summary: 'Reset the password with a single-use emailed token',
      description: 'On success every existing session is revoked and the user must log in again.',
      body: resetPasswordSchema,
      middleware: [limiters.passwordRecovery],
      response: { status: 200, description: 'Password reset' },
      handler: (ctx) => controller.resetPassword(ctx),
    }),
  ];
}
