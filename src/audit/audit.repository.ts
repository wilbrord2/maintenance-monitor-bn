import { type DataSource, type EntityManager } from 'typeorm';
import { buildPage, toOffset, type Page, type PageRequest } from '../common/pagination/pagination';
import { AuditLog } from './audit-log.entity';
import { type AuditAction, type AuditEntity } from './audit.constants';

export type NewAuditLog = Pick<
  AuditLog,
  | 'userId'
  | 'action'
  | 'entity'
  | 'entityId'
  | 'oldValues'
  | 'newValues'
  | 'ipAddress'
  | 'userAgent'
  | 'requestId'
>;

export interface AuditLogFilters {
  readonly userId?: number;
  readonly action?: AuditAction;
  readonly entity?: AuditEntity;
  readonly entityId?: string;
  readonly from?: Date;
  readonly to?: Date;
}

export class AuditRepository {
  constructor(private readonly dataSource: DataSource) {}

  private repo(manager?: EntityManager) {
    return (manager ?? this.dataSource.manager).getRepository(AuditLog);
  }

  async insert(entry: NewAuditLog, manager?: EntityManager): Promise<void> {
    const repository = this.repo(manager);
    await repository.save(repository.create(entry), { reload: false });
  }

  // withDeleted() must precede the join so that soft-deleted actors are still resolved.
  findById(id: string): Promise<AuditLog | null> {
    return this.repo()
      .createQueryBuilder('audit')
      .withDeleted()
      .leftJoinAndSelect('audit.user', 'user')
      .where('audit.id = :id', { id })
      .getOne();
  }

  async findPage(
    filters: AuditLogFilters,
    sortOrder: 'asc' | 'desc',
    page: PageRequest,
  ): Promise<Page<AuditLog>> {
    const query = this.repo()
      .createQueryBuilder('audit')
      .withDeleted()
      .leftJoinAndSelect('audit.user', 'user');

    if (filters.userId !== undefined) query.andWhere('audit.userId = :userId', { userId: filters.userId });
    if (filters.action) query.andWhere('audit.action = :action', { action: filters.action });
    if (filters.entity) query.andWhere('audit.entity = :entity', { entity: filters.entity });
    if (filters.entityId) query.andWhere('audit.entityId = :entityId', { entityId: filters.entityId });
    if (filters.from) query.andWhere('audit.createdAt >= :from', { from: filters.from });
    if (filters.to) query.andWhere('audit.createdAt < :to', { to: filters.to });

    const direction = sortOrder === 'asc' ? 'ASC' : 'DESC';
    const [items, total] = await query
      .orderBy('audit.createdAt', direction)
      .addOrderBy('audit.id', direction)
      .skip(toOffset(page))
      .take(page.limit)
      .getManyAndCount();
    return buildPage(items, total, page);
  }
}
