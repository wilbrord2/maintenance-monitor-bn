import { type EntityManager } from 'typeorm';
import { type AuditService } from '../audit/audit.service';
import { type TransactionRunner } from '../common/database/transaction-runner';
import { Role } from '../common/enums/role.enum';
import { SYSTEM_REQUEST_META } from '../common/http/request-meta';
import { type AppLogger } from '../common/logger/logger';
import { sha256Hex } from '../common/utils/crypto';
import { type MailService } from '../notifications/mail/mail.service';
import { type User } from '../users/user.entity';
import { type UsersRepository } from '../users/users.repository';
import { type AuthenticatedUser } from './auth.types';
import { type PasswordResetToken } from './entities/password-reset-token.entity';
import { type PasswordHasher } from './password-hasher';
import { PasswordService } from './password.service';
import { type PasswordResetTokenRepository } from './repositories/password-reset-token.repository';
import { type SessionService } from './session.service';

const NOW = new Date('2026-09-01T10:00:00Z');
const policy = {
  maxLoginAttempts: 5,
  lockoutMinutes: 15,
  temporaryPasswordTtlHours: 72,
  passwordResetTtlMinutes: 30,
  passwordResetUrl: 'https://app.example.test/reset-password',
  loginUrl: 'https://app.example.test/login',
  refreshCookieName: 'rt',
  cookieSecure: true,
};
const principal: AuthenticatedUser = {
  id: 7,
  name: 'Tess',
  email: 'tess@example.test',
  phone: '0780000007',
  role: Role.TECHNICIAN,
  sessionId: 'sid',
  mustChangePassword: true,
};

const user = (overrides: Partial<User> = {}) =>
  ({
    id: 7,
    email: 'tess@example.test',
    fullName: 'Tess',
    isActive: true,
    passwordHash: 'old-hash',
    mustChangePassword: true,
    ...overrides,
  }) as User;

function setup() {
  const users = {
    findById: jest.fn().mockResolvedValue(user()),
    findByEmail: jest.fn().mockResolvedValue(user()),
    findByIdForUpdate: jest.fn().mockResolvedValue(user()),
    save: jest.fn((value: User) => Promise.resolve(value)),
    registerFailedLogin: jest.fn(),
  } as unknown as jest.Mocked<UsersRepository>;
  const resetTokens = {
    insert: jest.fn(),
    invalidateOutstanding: jest.fn(),
    findByHashForUpdate: jest.fn(),
  } as unknown as jest.Mocked<PasswordResetTokenRepository>;
  const hasher = {
    hash: jest.fn().mockResolvedValue('new-hash'),
    verify: jest.fn(),
  } as unknown as jest.Mocked<PasswordHasher>;
  const sessions = {
    revokeAllSessions: jest.fn(),
    startSession: jest.fn().mockResolvedValue({ accessToken: 'a' }),
  } as unknown as jest.Mocked<SessionService>;
  const transactions = {
    run: jest.fn((work: (manager: EntityManager) => Promise<unknown>) => work({} as EntityManager)),
  } as unknown as jest.Mocked<TransactionRunner>;
  const audit = { record: jest.fn() } as unknown as jest.Mocked<AuditService>;
  const mail = {
    sendPasswordReset: jest.fn().mockResolvedValue(undefined),
    sendPasswordChanged: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<MailService>;
  const logger = { warn: jest.fn() } as unknown as AppLogger;
  const service = new PasswordService(
    users,
    resetTokens,
    hasher,
    sessions,
    transactions,
    audit,
    mail,
    policy,
    { now: () => NOW },
    logger,
  );
  return { service, users, resetTokens, hasher, sessions, audit, mail };
}

describe('PasswordService.changePassword', () => {
  it('completes onboarding: clears the temporary credential, revokes sessions, starts a new one', async () => {
    const { service, hasher, users, sessions, mail } = setup();
    hasher.verify.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await service.changePassword(
      principal,
      'Temp-Passw0rd!',
      'New-Passw0rd-123',
      SYSTEM_REQUEST_META,
    );

    expect(users.save).toHaveBeenCalledWith(
      expect.objectContaining({
        passwordHash: 'new-hash',
        mustChangePassword: false,
        passwordExpiresAt: null,
        passwordChangedAt: NOW,
      }),
      expect.anything(),
    );
    expect(sessions.revokeAllSessions).toHaveBeenCalledWith(7, 'PASSWORD_CHANGED', expect.anything());
    expect(result.tokens).toEqual({ accessToken: 'a' });
    expect(mail.sendPasswordChanged).not.toHaveBeenCalled();
  });

  it('counts a wrong current password towards lockout', async () => {
    const { service, hasher, users } = setup();
    hasher.verify.mockResolvedValue(false);
    await expect(
      service.changePassword(principal, 'wrong', 'New-Passw0rd-123', SYSTEM_REQUEST_META),
    ).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(users.registerFailedLogin).toHaveBeenCalledWith(7, 5, 15);
  });
});

describe('PasswordService reset flow', () => {
  it('stores only a hash of the emailed token and sets a 30-minute expiry', async () => {
    const { service, resetTokens, mail } = setup();
    await service.requestPasswordReset('tess@example.test', SYSTEM_REQUEST_META);

    const resetUrl = new URL(mail.sendPasswordReset.mock.calls[0]![0].resetUrl);
    const rawToken = resetUrl.searchParams.get('token')!;
    expect(resetUrl.origin + resetUrl.pathname).toBe('https://app.example.test/reset-password');
    expect(resetTokens.invalidateOutstanding).toHaveBeenCalled();
    expect(resetTokens.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenHash: sha256Hex(rawToken),
        expiresAt: new Date(NOW.getTime() + 30 * 60_000),
      }),
      expect.anything(),
    );
    expect(JSON.stringify(resetTokens.insert.mock.calls)).not.toContain(rawToken);
  });

  it('does nothing for unknown or inactive accounts', async () => {
    const { service, users, resetTokens, mail } = setup();
    users.findByEmail.mockResolvedValueOnce(null).mockResolvedValueOnce(user({ isActive: false }));
    await service.requestPasswordReset('ghost@example.test', SYSTEM_REQUEST_META);
    await service.requestPasswordReset('tess@example.test', SYSTEM_REQUEST_META);
    expect(resetTokens.insert).not.toHaveBeenCalled();
    expect(mail.sendPasswordReset).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<PasswordResetToken> | null]>([
    ['unknown', null],
    ['used', { usedAt: new Date(NOW.getTime() - 1000) }],
    ['expired', { expiresAt: new Date(NOW.getTime() - 1) }],
  ])('rejects a %s token', async (_label, token) => {
    const { service, resetTokens, users } = setup();
    resetTokens.findByHashForUpdate.mockResolvedValue(
      token
        ? ({
            userId: 7,
            usedAt: null,
            expiresAt: new Date(NOW.getTime() + 60_000),
            ...token,
          } as PasswordResetToken)
        : null,
    );
    await expect(
      service.resetPassword('raw-token', 'New-Passw0rd-123', SYSTEM_REQUEST_META),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_RESET_TOKEN',
    });
    expect(users.save).not.toHaveBeenCalled();
  });

  it('consumes a valid token, revokes every session and notifies the user', async () => {
    const { service, resetTokens, sessions, mail } = setup();
    resetTokens.findByHashForUpdate.mockResolvedValue({
      userId: 7,
      usedAt: null,
      expiresAt: new Date(NOW.getTime() + 60_000),
    } as PasswordResetToken);
    await service.resetPassword('raw-token', 'New-Passw0rd-123', SYSTEM_REQUEST_META);
    expect(resetTokens.findByHashForUpdate).toHaveBeenCalledWith(sha256Hex('raw-token'), expect.anything());
    expect(resetTokens.invalidateOutstanding).toHaveBeenCalledWith(7, NOW, expect.anything());
    expect(sessions.revokeAllSessions).toHaveBeenCalledWith(7, 'PASSWORD_RESET', expect.anything());
    expect(mail.sendPasswordChanged).toHaveBeenCalled();
  });
});
