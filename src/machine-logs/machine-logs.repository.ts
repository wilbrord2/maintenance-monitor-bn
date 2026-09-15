import { type DataSource, type EntityManager, type SelectQueryBuilder } from 'typeorm';
import { type LogStatus } from '../common/enums/log-status.enum';
import { type MachineState } from '../common/enums/machine-state.enum';
import {
  buildPage,
  escapeLikePattern,
  toOffset,
  type Page,
  type PageRequest,
} from '../common/pagination/pagination';
import { MachineLog } from './machine-log.entity';

export const MACHINE_LOG_SORT_FIELDS = ['createdAt', 'startedAt', 'updatedAt', 'downtimeHours'] as const;
export type MachineLogSortField = (typeof MACHINE_LOG_SORT_FIELDS)[number];

export interface MachineLogFilters {
  readonly machineId?: number;
  readonly userId?: number;
  readonly entryStatus?: MachineState;
  readonly resultingState?: MachineState;
  readonly logStatus?: LogStatus;
  /** Inclusive lower bound on startedAt. */
  readonly from?: Date;
  /** Exclusive upper bound on startedAt. */
  readonly to?: Date;
  readonly search?: string;
}

export class MachineLogsRepository {
  constructor(private readonly dataSource: DataSource) {}

  private repo(manager?: EntityManager) {
    return (manager ?? this.dataSource.manager).getRepository(MachineLog);
  }

  /** Logs with their machine and author, which stay visible even when soft-deleted. */
  private withRelations(manager?: EntityManager): SelectQueryBuilder<MachineLog> {
    return this.repo(manager)
      .createQueryBuilder('log')
      .withDeleted()
      .innerJoinAndSelect('log.machine', 'machine')
      .innerJoinAndSelect('log.user', 'user')
      .where('log.deletedAt IS NULL');
  }

  create(values: Partial<MachineLog>): MachineLog {
    return this.repo().create(values);
  }

  save(log: MachineLog, manager: EntityManager): Promise<MachineLog> {
    return this.repo(manager).save(log);
  }

  findById(id: number, manager?: EntityManager): Promise<MachineLog | null> {
    return this.withRelations(manager).andWhere('log.id = :id', { id }).getOne();
  }

  /** Locks a (non-deleted) log row. Callers must already hold the machine lock. */
  findByIdForUpdate(id: number, manager: EntityManager): Promise<MachineLog | null> {
    return this.repo(manager)
      .createQueryBuilder('log')
      .setLock('pessimistic_write')
      .where('log.id = :id', { id })
      .getOne();
  }

  /**
   * Id of the machine's most recent non-deleted log. Ids are assigned while the
   * machine row is locked, so they are strictly ordered per machine (unlike
   * created_at, which records transaction start time).
   */
  async findLatestIdForMachine(machineId: number, manager: EntityManager): Promise<number | null> {
    const row = await this.repo(manager)
      .createQueryBuilder('log')
      .select('MAX(log.id)', 'latestId')
      .where('log.machineId = :machineId', { machineId })
      .getRawOne<{ latestId: number | null }>();
    return row?.latestId ?? null;
  }

  async findPage(
    filters: MachineLogFilters,
    sort: { sortBy: MachineLogSortField; sortOrder: 'asc' | 'desc' },
    page: PageRequest,
  ): Promise<Page<MachineLog>> {
    const query = this.withRelations();
    if (filters.machineId !== undefined)
      query.andWhere('log.machineId = :machineId', { machineId: filters.machineId });
    if (filters.userId !== undefined) query.andWhere('log.userId = :userId', { userId: filters.userId });
    if (filters.entryStatus)
      query.andWhere('log.entryStatus = :entryStatus', { entryStatus: filters.entryStatus });
    if (filters.resultingState) {
      query.andWhere('log.resultingState = :resultingState', { resultingState: filters.resultingState });
    }
    if (filters.logStatus) query.andWhere('log.logStatus = :logStatus', { logStatus: filters.logStatus });
    if (filters.from) query.andWhere('log.startedAt >= :from', { from: filters.from });
    if (filters.to) query.andWhere('log.startedAt < :to', { to: filters.to });
    if (filters.search) {
      query.andWhere(
        `(log.faultDescription ILIKE :search ESCAPE '\\' OR log.causeDescription ILIKE :search ESCAPE '\\'
          OR log.remedyAction ILIKE :search ESCAPE '\\')`,
        { search: `%${escapeLikePattern(filters.search)}%` },
      );
    }

    const direction = sort.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const [items, total] = await query
      .orderBy(`log.${sort.sortBy}`, direction)
      .addOrderBy('log.id', direction)
      .skip(toOffset(page))
      .take(page.limit)
      .getManyAndCount();
    return buildPage(items, total, page);
  }

  async softDelete(id: number, manager: EntityManager): Promise<void> {
    await this.repo(manager).softDelete({ id });
  }
}
