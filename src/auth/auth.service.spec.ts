import { type AuditService } from '../audit/audit.service';
import { Role } from '../common/enums/role.enum';
import { AppError } from '../common/errors/app-error';
import { SYSTEM_REQUEST_META } from '../common/http/request-meta';
import { type User } from '../users/user.entity';
import { type UsersRepository } from '../users/users.repository';
import { AuthService } from './auth.service';
import { type PasswordHasher } from './password-hasher';
import { type SessionService } from './session.service';

const NOW = new Date('2026-09-01T10:00:00Z');
const policy = {
  maxLoginAttempts: 5,
  lockoutMinutes: 15,
  temporaryPasswordTtlHours: 72,
  passwordResetTtlMinutes: 30,
  passwordResetUrl: 'http://localhost/reset',
  loginUrl: 'http://localhost/login',
  refreshCookieName: 'rt',
  cookieSecure: false,
};

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 7,
    fullName: 'Tess Tech',
    email: 'tess@example.test',
    phone: '0780000007',
    passwordHash: '$argon2id$hash',
    position: null,
    role: Role.TECHNICIAN,
    isActive: true,
    mustChangePassword: false,
    passwordExpiresAt: null,
    passwordChangedAt: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function setup(user: User | null, passwordValid = true) {
  const users = {
    findByEmail: jest.fn().mockResolvedValue(user),
    registerFailedLogin: jest.fn().mockResolvedValue({ attempts: 1, lockedUntil: null }),
    registerSuccessfulLogin: jest.fn().mockResolvedValue(undefined),
    updatePasswordHash: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<UsersRepository>;
  const hasher: jest.Mocked<PasswordHasher> = {
    hash: jest.fn().mockResolvedValue('$argon2id$new'),
    verify: jest.fn().mockResolvedValue(passwordValid),
    needsRehash: jest.fn().mockReturnValue(false),
    verifyDummy: jest.fn().mockResolvedValue(undefined),
  };
  const tokens = {
    accessToken: 'a',
    accessTokenExpiresAt: NOW,
    refreshToken: 'r',
    refreshTokenExpiresAt: NOW,
  };
  const sessions = {
    startSession: jest.fn().mockResolvedValue(tokens),
  } as unknown as jest.Mocked<SessionService>;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;
  const service = new AuthService(users, hasher, sessions, audit, policy, { now: () => NOW });
  return { service, users, hasher, sessions, audit };
}

async function expectError(promise: Promise<unknown>, status: number, code: string) {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toMatchObject({ statusCode: status, code });
}

describe('AuthService.login', () => {
  it('issues a session and records success', async () => {
    const { service, users, sessions, audit } = setup(makeUser());
    const result = await service.login('tess@example.test', 'pw', SYSTEM_REQUEST_META);

    expect(result.tokens.accessToken).toBe('a');
    expect(users.registerSuccessfulLogin).toHaveBeenCalledWith(7, NOW);
    expect(sessions.startSession).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'LOGIN_SUCCEEDED', actorId: 7 }),
    );
  });

  it('performs dummy verification for unknown emails to equalise timing', async () => {
    const { service, hasher, audit } = setup(null);
    await expectError(
      service.login('ghost@example.test', 'pw', SYSTEM_REQUEST_META),
      401,
      'INVALID_CREDENTIALS',
    );
    expect(hasher.verifyDummy).toHaveBeenCalledWith('pw');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'LOGIN_FAILED',
        actorId: null,
        newValues: { email: 'ghost@example.test', reason: 'UNKNOWN_EMAIL' },
      }),
    );
  });

  it('refuses locked accounts without checking the password', async () => {
    const { service, hasher } = setup(makeUser({ lockedUntil: new Date(NOW.getTime() + 60_000) }));
    await expectError(service.login('tess@example.test', 'pw', SYSTEM_REQUEST_META), 423, 'ACCOUNT_LOCKED');
    expect(hasher.verify).not.toHaveBeenCalled();
  });

  it('counts failed attempts and audits a lockout', async () => {
    const { service, users, audit } = setup(makeUser(), false);
    users.registerFailedLogin.mockResolvedValue({
      attempts: 0,
      lockedUntil: new Date(NOW.getTime() + 900_000),
    });

    await expectError(
      service.login('tess@example.test', 'bad', SYSTEM_REQUEST_META),
      401,
      'INVALID_CREDENTIALS',
    );
    expect(users.registerFailedLogin).toHaveBeenCalledWith(7, 5, 15);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'ACCOUNT_LOCKED' }));
  });

  it('rejects inactive accounts only after a correct password', async () => {
    const { service, sessions } = setup(makeUser({ isActive: false }));
    await expectError(service.login('tess@example.test', 'pw', SYSTEM_REQUEST_META), 403, 'USER_INACTIVE');
    expect(sessions.startSession).not.toHaveBeenCalled();
  });

  it('rejects an expired temporary credential', async () => {
    const { service } = setup(
      makeUser({ mustChangePassword: true, passwordExpiresAt: new Date(NOW.getTime() - 1) }),
    );
    await expectError(
      service.login('tess@example.test', 'pw', SYSTEM_REQUEST_META),
      401,
      'TEMPORARY_PASSWORD_EXPIRED',
    );
  });

  it('allows a valid temporary credential and flags the required password change', async () => {
    const { service } = setup(
      makeUser({ mustChangePassword: true, passwordExpiresAt: new Date(NOW.getTime() + 1000) }),
    );
    const result = await service.login('tess@example.test', 'pw', SYSTEM_REQUEST_META);
    expect(result.mustChangePassword).toBe(true);
  });

  it('upgrades outdated password hashes transparently', async () => {
    const { service, hasher, users } = setup(makeUser());
    hasher.needsRehash.mockReturnValue(true);
    await service.login('tess@example.test', 'pw', SYSTEM_REQUEST_META);
    expect(users.updatePasswordHash).toHaveBeenCalledWith(7, '$argon2id$new');
  });
});
