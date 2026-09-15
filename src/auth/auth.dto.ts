import { z } from 'zod';
import { emailAddress, passwordInput, strongPassword } from '../common/validation/primitives';
import { userResponseSchema } from '../users/users.dto';

export const loginSchema = z
  .object({
    email: emailAddress,
    password: passwordInput,
  })
  .strict()
  .meta({ id: 'LoginRequest' });
export type LoginDto = z.output<typeof loginSchema>;

const jwtString = z.string().min(20).max(4096);

export const refreshSchema = z
  .object({
    refreshToken: jwtString
      .optional()
      .meta({ description: 'Refresh token. May be omitted when sent in the httpOnly refresh cookie.' }),
  })
  .strict()
  .meta({ id: 'RefreshRequest' });
export type RefreshDto = z.output<typeof refreshSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: passwordInput,
    newPassword: strongPassword,
  })
  .strict()
  .meta({ id: 'ChangePasswordRequest' });
export type ChangePasswordDto = z.output<typeof changePasswordSchema>;

export const forgotPasswordSchema = z
  .object({ email: emailAddress })
  .strict()
  .meta({ id: 'ForgotPasswordRequest' });
export type ForgotPasswordDto = z.output<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    token: z
      .string()
      .min(32)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/, 'is malformed'),
    newPassword: strongPassword,
  })
  .strict()
  .meta({ id: 'ResetPasswordRequest' });
export type ResetPasswordDto = z.output<typeof resetPasswordSchema>;

export const tokenPairResponseSchema = z
  .object({
    tokenType: z.literal('Bearer'),
    accessToken: z.string(),
    accessTokenExpiresAt: z.iso.datetime(),
    refreshToken: z.string(),
    refreshTokenExpiresAt: z.iso.datetime(),
  })
  .meta({ id: 'TokenPair' });

export const authSessionResponseSchema = z
  .object({
    user: userResponseSchema,
    mustChangePassword: z.boolean(),
    tokens: tokenPairResponseSchema,
  })
  .meta({ id: 'AuthSession' });
