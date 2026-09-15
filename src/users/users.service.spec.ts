import { type EntityManager } from 'typeorm';
import { type AuditService } from '../audit/audit.service';
import { type AuthenticatedUser } from '../auth/auth.types';
import { type PasswordHasher } from '../auth/password-hasher';
import { type SessionService } from '../auth/session.service';
import { type TransactionRunner } from '../common/database/transaction-runner';
import { Role } from '../common/enums/role.enum';
import { AppError } from '../common/errors/app-error';
import { SYSTEM_REQUEST_META } from '../common/http/request-meta';
import { type MailService } from '../notifications/mail/mail.service';
import { type User } from './user.entity';
import { type UsersRepository } from './users.repository';
import { UsersService } from './users.service';

const NOW = new Date('2026-09-01T10:00:00Z');
const admin: AuthenticatedUser = {
  id: 1,
  name: 'Admin',
  email: 'admin@example.test',
  phone: '0780000001',
  role: Role.ADMIN,
  sessionId: 'sid',
  mustChangePassword: false,
};
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

function setup() {
  const saved: User[] = [];
  const users = {
    findConflicts: jest.fn().mockResolvedValue({ email: false, phone: false }),
    create: jest.fn((values: Partial<User>) => ({ ...values }) as User),
    save: jest.fn((user: Partial<User>) => {
      const persisted = Object.assign({}, user, {
        id: user.id ?? 42,
        createdAt: NOW,
        updatedAt: NOW,
      }) as User;
      saved.push(persisted);
      return Promise.resolve(persisted);
    }),
    findByIdForUpdate: jest.fn(),
    softDelete: jest.fn(),
  } as unknown as jest.Mocked<UsersRepository>;
  const hasher = {
    hash: jest.fn().mockResolvedValue('$argon2id$temp'),
  } as unknown as jest.Mocked<PasswordHasher>;
  const sessions = { revokeAllSessions: jest.fn() } as unknown as jest.Mocked<SessionService>;
  const transactions = {
    run: jest.fn((work: (manager: EntityManager) => Promise<unknown>) => work({} as EntityManager)),
  } as unknown as jest.Mocked<TransactionRunner>;
  const audit = { record: jest.fn() } as unknown as jest.Mocked<AuditService>;
  const mail = {
    sendTechnicianOnboarding: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<MailService>;
  const service = new UsersService(users, hasher, sessions, transactions, audit, mail, policy, {
    now: () => NOW,
  });
  return { service, users, hasher, sessions, audit, mail, saved };
}

const dto = { fullName: 'New Tech', email: 'new@example.test', phone: '0781111111' };

describe('UsersService.createTechnician', () => {
  it('creates a technician with a hashed, expiring temporary credential and emails it', async () => {
    const { service, hasher, mail, audit, saved } = setup();
    const user = await service.createTechnician(dto, admin, SYSTEM_REQUEST_META);

    const temporaryPassword = hasher.hash.mock.calls[0]![0];
    expect(temporaryPassword).toHaveLength(16);
    expect(saved[0]).toMatchObject({
      role: Role.TECHNICIAN,
      passwordHash: '$argon2id$temp',
      mustChangePassword: true,
      passwordExpiresAt: new Date(NOW.getTime() + 72 * 3600 * 1000),
    });
    expect(mail.sendTechnicianOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'new@example.test', temporaryPassword }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(temporaryPassword);
    expect(user.id).toBe(42);
  });

  it('rejects duplicates before doing any work', async () => {
    const { service, users, hasher } = setup();
    users.findConflicts.mockResolvedValue({ email: false, phone: true });
    await expect(service.createTechnician(dto, admin, SYSTEM_REQUEST_META)).rejects.toMatchObject({
      code: 'USER_PHONE_EXISTS',
      statusCode: 409,
    });
    expect(hasher.hash).not.toHaveBeenCalled();
  });

  it('fails (rolling back) when the onboarding email cannot be sent', async () => {
    const { service, mail } = setup();
    mail.sendTechnicianOnboarding.mockRejectedValue(new Error('smtp down'));
    const promise = service.createTechnician(dto, admin, SYSTEM_REQUEST_META);
    await expect(promise).rejects.toBeInstanceOf(AppError);
    await expect(promise).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
  });
});

describe('UsersService account status', () => {
  it('forbids administrators from deactivating themselves', async () => {
    const { service, users } = setup();
    await expect(service.setActive(admin.id, false, admin, SYSTEM_REQUEST_META)).rejects.toMatchObject({
      code: 'USER_SELF_MODIFICATION_FORBIDDEN',
    });
    expect(users.findByIdForUpdate).not.toHaveBeenCalled();
  });

  it('revokes sessions on deactivation', async () => {
    const { service, users, sessions } = setup();
    users.findByIdForUpdate.mockResolvedValue({ id: 9, isActive: true, role: Role.TECHNICIAN } as User);
    await service.setActive(9, false, admin, SYSTEM_REQUEST_META);
    expect(sessions.revokeAllSessions).toHaveBeenCalledWith(9, 'USER_DEACTIVATED', expect.anything());
  });

  it('is a no-op when the status does not change', async () => {
    const { service, users, audit } = setup();
    users.findByIdForUpdate.mockResolvedValue({ id: 9, isActive: true } as User);
    await service.setActive(9, true, admin, SYSTEM_REQUEST_META);
    expect(audit.record).not.toHaveBeenCalled();
  });
});
