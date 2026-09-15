import { type DataSource, type EntityManager } from 'typeorm';
import { type Role } from '../common/enums/role.enum';
import {
  buildPage,
  escapeLikePattern,
  toOffset,
  type Page,
  type PageRequest,
} from '../common/pagination/pagination';
import { User } from './user.entity';

export const USER_SORT_FIELDS = ['createdAt', 'fullName', 'email', 'lastLoginAt'] as const;
export type UserSortField = (typeof USER_SORT_FIELDS)[number];

export interface UserFilters {
  readonly role?: Role;
  readonly isActive?: boolean;
  readonly search?: string;
}

export interface FailedLoginResult {
  readonly attempts: number;
  readonly lockedUntil: Date | null;
}

export class UsersRepository {
  constructor(private readonly dataSource: DataSource) {}

  private repo(manager?: EntityManager) {
    return (manager ?? this.dataSource.manager).getRepository(User);
  }

  create(values: Partial<User>): User {
    return this.repo().create(values);
  }

  save(user: User, manager?: EntityManager): Promise<User> {
    return this.repo(manager).save(user);
  }

  findById(id: number, manager?: EntityManager): Promise<User | null> {
    return this.repo(manager).findOne({ where: { id } });
  }

  /** Locks the user row for the rest of the transaction. */
  findByIdForUpdate(id: number, manager: EntityManager): Promise<User | null> {
    return this.repo(manager)
      .createQueryBuilder('user')
      .setLock('pessimistic_write')
      .where('user.id = :id', { id })
      .getOne();
  }

  findByEmail(email: string, manager?: EntityManager): Promise<User | null> {
    return this.repo(manager).findOne({ where: { email: email.toLowerCase() } });
  }

  /** Finds a conflicting email/phone, including soft-deleted users (uniqueness is global). */
  async findConflicts(
    values: { email?: string; phone?: string },
    excludeUserId?: number,
  ): Promise<{ email: boolean; phone: boolean }> {
    const conditions: string[] = [];
    if (values.email) conditions.push('user.email = :email');
    if (values.phone) conditions.push('user.phone = :phone');
    if (conditions.length === 0) return { email: false, phone: false };

    const query = this.repo()
      .createQueryBuilder('user')
      .withDeleted()
      .select(['user.id', 'user.email', 'user.phone'])
      .where(`(${conditions.join(' OR ')})`, { email: values.email, phone: values.phone });
    if (excludeUserId !== undefined) query.andWhere('user.id <> :excludeUserId', { excludeUserId });

    const matches = await query.getMany();
    return {
      email: values.email !== undefined && matches.some((user) => user.email === values.email),
      phone: values.phone !== undefined && matches.some((user) => user.phone === values.phone),
    };
  }

  async findPage(
    filters: UserFilters,
    sort: { sortBy: UserSortField; sortOrder: 'asc' | 'desc' },
    page: PageRequest,
  ): Promise<Page<User>> {
    const query = this.repo().createQueryBuilder('user');
    if (filters.role) query.andWhere('user.role = :role', { role: filters.role });
    if (filters.isActive !== undefined)
      query.andWhere('user.isActive = :isActive', { isActive: filters.isActive });
    if (filters.search) {
      query.andWhere(
        "(user.fullName ILIKE :search ESCAPE '\\' OR user.email ILIKE :search ESCAPE '\\' OR user.phone ILIKE :search ESCAPE '\\')",
        { search: `%${escapeLikePattern(filters.search)}%` },
      );
    }
    const direction = sort.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const [items, total] = await query
      .orderBy(`user.${sort.sortBy}`, direction, direction === 'ASC' ? 'NULLS FIRST' : 'NULLS LAST')
      .addOrderBy('user.id', direction)
      .skip(toOffset(page))
      .take(page.limit)
      .getManyAndCount();
    return buildPage(items, total, page);
  }

  /**
   * Atomically increments the failed-login counter. When the threshold is
   * reached the account is locked and the counter restarts, so concurrent
   * guesses cannot exceed the limit.
   */
  async registerFailedLogin(
    userId: number,
    maxAttempts: number,
    lockMinutes: number,
  ): Promise<FailedLoginResult> {
    // Both CASE expressions read the pre-update row, so they agree on whether this attempt locks.
    const reachesLimit = '"failed_login_attempts" + 1 >= CAST(:maxAttempts AS integer)';
    const result = await this.repo()
      .createQueryBuilder()
      .update(User)
      .set({
        failedLoginAttempts: () => `CASE WHEN ${reachesLimit} THEN 0 ELSE "failed_login_attempts" + 1 END`,
        lockedUntil: () =>
          `CASE WHEN ${reachesLimit} THEN now() + make_interval(mins => CAST(:lockMinutes AS integer)) ELSE "locked_until" END`,
      })
      .where('id = :userId', { userId })
      .setParameters({ maxAttempts, lockMinutes })
      // String form: TypeORM ignores unmapped names in the array form and would emit no RETURNING clause.
      .returning('"failed_login_attempts", "locked_until"')
      .execute();
    const [row] = result.raw as { failed_login_attempts: number; locked_until: Date | null }[];
    return { attempts: row?.failed_login_attempts ?? 0, lockedUntil: row?.locked_until ?? null };
  }

  async registerSuccessfulLogin(userId: number, at: Date): Promise<void> {
    await this.repo().update({ id: userId }, { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: at });
  }

  async updatePasswordHash(userId: number, passwordHash: string, manager?: EntityManager): Promise<void> {
    await this.repo(manager).update({ id: userId }, { passwordHash });
  }

  async softDelete(userId: number, manager: EntityManager): Promise<void> {
    await this.repo(manager).update({ id: userId }, { isActive: false });
    await this.repo(manager).softDelete({ id: userId });
  }
}
