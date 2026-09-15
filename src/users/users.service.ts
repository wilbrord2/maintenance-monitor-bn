import { type EntityManager } from 'typeorm';
import { AuditAction, AuditEntity } from '../audit/audit.constants';
import { type AuditService } from '../audit/audit.service';
import { diffValues } from '../audit/audit-sanitizer';
import { SessionRevocationReason } from '../auth/entities/refresh-token.entity';
import { type AuthenticatedUser } from '../auth/auth.types';
import { type PasswordHasher } from '../auth/password-hasher';
import { type SessionService } from '../auth/session.service';
import { type TransactionRunner } from '../common/database/transaction-runner';
import { Role } from '../common/enums/role.enum';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { constraintName, isUniqueViolation } from '../common/errors/database-errors';
import { type RequestMeta } from '../common/http/request-meta';
import { type Page } from '../common/pagination/pagination';
import { addHours, type Clock } from '../common/utils/clock';
import { generateTemporaryPassword } from '../common/utils/crypto';
import { type AppConfig } from '../config/config';
import { type MailService } from '../notifications/mail/mail.service';
import { type User } from './user.entity';
import { toUserAuditSnapshot } from './user.mapper';
import {
  type CreateTechnicianDto,
  type ListUsersQuery,
  type UpdateProfileDto,
  type UpdateUserDto,
} from './users.dto';
import { type UsersRepository } from './users.repository';

export class UsersService {
  constructor(
    private readonly users: UsersRepository,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionService,
    private readonly transactions: TransactionRunner,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly policy: AppConfig['auth'],
    private readonly clock: Clock,
  ) {}

  /**
   * Creates a technician with a temporary credential and emails it. The email
   * is sent before the transaction commits: if delivery fails the account is
   * not created, so no technician can exist without having received credentials.
   * The temporary password is never returned or logged.
   */
  async createTechnician(
    dto: CreateTechnicianDto,
    actor: AuthenticatedUser,
    meta: RequestMeta,
  ): Promise<User> {
    await this.assertUnique({ email: dto.email, phone: dto.phone });

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.hasher.hash(temporaryPassword);
    const expiresAt = addHours(this.clock.now(), this.policy.temporaryPasswordTtlHours);

    return this.withUniqueViolationMapping(() =>
      this.transactions.run(async (manager) => {
        const user = await this.users.save(
          this.users.create({
            fullName: dto.fullName,
            email: dto.email,
            phone: dto.phone,
            position: dto.position ?? null,
            role: Role.TECHNICIAN,
            passwordHash,
            isActive: true,
            mustChangePassword: true,
            passwordExpiresAt: expiresAt,
          }),
          manager,
        );
        await this.audit.record(
          {
            action: AuditAction.TECHNICIAN_CREATED,
            entity: AuditEntity.USER,
            entityId: user.id,
            actorId: actor.id,
            newValues: { ...toUserAuditSnapshot(user), temporaryCredentialExpiresAt: expiresAt },
            meta,
          },
          manager,
        );
        await this.sendOnboardingEmail(user, temporaryPassword, expiresAt);
        return user;
      }),
    );
  }

  /** Issues a new temporary credential (e.g. expired before first login) and signs the technician out. */
  async reissueTemporaryPassword(userId: number, actor: AuthenticatedUser, meta: RequestMeta): Promise<User> {
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.hasher.hash(temporaryPassword);
    const expiresAt = addHours(this.clock.now(), this.policy.temporaryPasswordTtlHours);

    return this.transactions.run(async (manager) => {
      const user = await this.getForUpdate(userId, manager);
      if (user.role !== Role.TECHNICIAN) {
        throw AppError.unprocessable(
          'Temporary passwords can only be issued to technicians',
          ErrorCode.USER_NOT_TECHNICIAN,
        );
      }
      if (!user.isActive) {
        throw AppError.unprocessable(
          'Activate the user before issuing a temporary password',
          ErrorCode.USER_INACTIVE,
        );
      }

      user.passwordHash = passwordHash;
      user.mustChangePassword = true;
      user.passwordExpiresAt = expiresAt;
      user.failedLoginAttempts = 0;
      user.lockedUntil = null;
      await this.users.save(user, manager);
      await this.sessions.revokeAllSessions(user.id, SessionRevocationReason.PASSWORD_RESET, manager);
      await this.audit.record(
        {
          action: AuditAction.TEMPORARY_CREDENTIAL_REISSUED,
          entity: AuditEntity.USER,
          entityId: user.id,
          actorId: actor.id,
          newValues: { temporaryCredentialExpiresAt: expiresAt },
          meta,
        },
        manager,
      );
      await this.sendOnboardingEmail(user, temporaryPassword, expiresAt);
      return user;
    });
  }

  list(query: ListUsersQuery): Promise<Page<User>> {
    return this.users.findPage(
      {
        ...(query.role ? { role: query.role } : {}),
        ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
        ...(query.search ? { search: query.search } : {}),
      },
      { sortBy: query.sortBy, sortOrder: query.sortOrder },
      { page: query.page, limit: query.limit },
    );
  }

  async getById(id: number): Promise<User> {
    const user = await this.users.findById(id);
    if (!user) throw AppError.notFound('User not found', ErrorCode.USER_NOT_FOUND);
    return user;
  }

  async update(id: number, dto: UpdateUserDto, actor: AuthenticatedUser, meta: RequestMeta): Promise<User> {
    return this.applyUpdate(id, dto, actor, meta, AuditAction.USER_UPDATED);
  }

  async updateProfile(actor: AuthenticatedUser, dto: UpdateProfileDto, meta: RequestMeta): Promise<User> {
    return this.applyUpdate(actor.id, dto, actor, meta, AuditAction.USER_PROFILE_UPDATED);
  }

  async setActive(id: number, isActive: boolean, actor: AuthenticatedUser, meta: RequestMeta): Promise<User> {
    if (id === actor.id) {
      throw AppError.forbidden(
        'You cannot change the status of your own account',
        ErrorCode.USER_SELF_MODIFICATION_FORBIDDEN,
      );
    }
    return this.transactions.run(async (manager) => {
      const user = await this.getForUpdate(id, manager);
      if (user.isActive === isActive) return user;

      user.isActive = isActive;
      await this.users.save(user, manager);
      if (!isActive) {
        await this.sessions.revokeAllSessions(user.id, SessionRevocationReason.USER_DEACTIVATED, manager);
      }
      await this.audit.record(
        {
          action: isActive ? AuditAction.USER_ACTIVATED : AuditAction.USER_DEACTIVATED,
          entity: AuditEntity.USER,
          entityId: user.id,
          actorId: actor.id,
          oldValues: { isActive: !isActive },
          newValues: { isActive },
          meta,
        },
        manager,
      );
      return user;
    });
  }

  /** Soft-deletes a user. Historical machine logs keep their author reference. */
  async remove(id: number, actor: AuthenticatedUser, meta: RequestMeta): Promise<void> {
    if (id === actor.id) {
      throw AppError.forbidden(
        'You cannot delete your own account',
        ErrorCode.USER_SELF_MODIFICATION_FORBIDDEN,
      );
    }
    await this.transactions.run(async (manager) => {
      const user = await this.getForUpdate(id, manager);
      await this.users.softDelete(user.id, manager);
      await this.sessions.revokeAllSessions(user.id, SessionRevocationReason.USER_DEACTIVATED, manager);
      await this.audit.record(
        {
          action: AuditAction.USER_DELETED,
          entity: AuditEntity.USER,
          entityId: user.id,
          actorId: actor.id,
          oldValues: toUserAuditSnapshot(user),
          meta,
        },
        manager,
      );
    });
  }

  private async applyUpdate(
    id: number,
    changes: UpdateUserDto,
    actor: AuthenticatedUser,
    meta: RequestMeta,
    action: typeof AuditAction.USER_UPDATED | typeof AuditAction.USER_PROFILE_UPDATED,
  ): Promise<User> {
    await this.assertUnique(
      {
        ...(changes.email !== undefined ? { email: changes.email } : {}),
        ...(changes.phone !== undefined ? { phone: changes.phone } : {}),
      },
      id,
    );

    return this.withUniqueViolationMapping(() =>
      this.transactions.run(async (manager) => {
        const user = await this.getForUpdate(id, manager);
        const before = toUserAuditSnapshot(user);

        if (changes.fullName !== undefined) user.fullName = changes.fullName;
        if (changes.email !== undefined) user.email = changes.email;
        if (changes.phone !== undefined) user.phone = changes.phone;
        if (changes.position !== undefined) user.position = changes.position;

        const { oldValues, newValues } = diffValues(before, toUserAuditSnapshot(user));
        if (Object.keys(newValues).length === 0) return user;

        await this.users.save(user, manager);
        await this.audit.record(
          {
            action,
            entity: AuditEntity.USER,
            entityId: user.id,
            actorId: actor.id,
            oldValues,
            newValues,
            meta,
          },
          manager,
        );
        return user;
      }),
    );
  }

  private async getForUpdate(id: number, manager: EntityManager): Promise<User> {
    const user = await this.users.findByIdForUpdate(id, manager);
    if (!user) throw AppError.notFound('User not found', ErrorCode.USER_NOT_FOUND);
    return user;
  }

  private async assertUnique(
    values: { email?: string; phone?: string },
    excludeUserId?: number,
  ): Promise<void> {
    const conflicts = await this.users.findConflicts(values, excludeUserId);
    if (conflicts.email)
      throw AppError.conflict('A user with this email already exists', ErrorCode.USER_EMAIL_EXISTS);
    if (conflicts.phone) {
      throw AppError.conflict('A user with this phone number already exists', ErrorCode.USER_PHONE_EXISTS);
    }
  }

  /** The pre-check gives friendly errors; the unique constraints remain the source of truth under races. */
  private async withUniqueViolationMapping<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        const constraint = constraintName(error);
        if (constraint === 'UQ_users_email') {
          throw AppError.conflict('A user with this email already exists', ErrorCode.USER_EMAIL_EXISTS);
        }
        if (constraint === 'UQ_users_phone') {
          throw AppError.conflict(
            'A user with this phone number already exists',
            ErrorCode.USER_PHONE_EXISTS,
          );
        }
      }
      throw error;
    }
  }

  private async sendOnboardingEmail(user: User, temporaryPassword: string, expiresAt: Date): Promise<void> {
    try {
      await this.mail.sendTechnicianOnboarding({
        to: user.email,
        fullName: user.fullName,
        temporaryPassword,
        expiresAt,
        loginUrl: this.policy.loginUrl,
      });
    } catch {
      throw new AppError(
        503,
        ErrorCode.SERVICE_UNAVAILABLE,
        'The credentials email could not be sent, so no changes were saved. Please try again later.',
      );
    }
  }
}
