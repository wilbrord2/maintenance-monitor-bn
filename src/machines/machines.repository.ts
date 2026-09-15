import { type DataSource, type EntityManager } from 'typeorm';
import { LogStatus } from '../common/enums/log-status.enum';
import { type MachineState } from '../common/enums/machine-state.enum';
import {
  buildPage,
  escapeLikePattern,
  toOffset,
  type Page,
  type PageRequest,
} from '../common/pagination/pagination';
import { MachineLog } from '../machine-logs/machine-log.entity';
import { Machine } from './machine.entity';

export const MACHINE_SORT_FIELDS = ['name', 'serialNumber', 'status', 'createdAt', 'updatedAt'] as const;
export type MachineSortField = (typeof MACHINE_SORT_FIELDS)[number];

export interface MachineFilters {
  readonly status?: MachineState;
  readonly isActive?: boolean;
  readonly search?: string;
}

export interface MachineActivitySummary {
  readonly totalLogs: number;
  readonly openLogs: number;
  readonly lastActivityAt: Date | null;
}

export const EMPTY_ACTIVITY: MachineActivitySummary = { totalLogs: 0, openLogs: 0, lastActivityAt: null };

export class MachinesRepository {
  constructor(private readonly dataSource: DataSource) {}

  private repo(manager?: EntityManager) {
    return (manager ?? this.dataSource.manager).getRepository(Machine);
  }

  create(values: Partial<Machine>): Machine {
    return this.repo().create(values);
  }

  save(machine: Machine, manager?: EntityManager): Promise<Machine> {
    return this.repo(manager).save(machine);
  }

  findById(id: number, manager?: EntityManager): Promise<Machine | null> {
    return this.repo(manager).findOne({ where: { id } });
  }

  /**
   * Reads the machine with a row-level `FOR UPDATE` lock. Every operation that
   * changes machine status acquires this lock first, serialising concurrent
   * updates to the same machine and giving a single lock order (no deadlocks).
   */
  findByIdForUpdate(id: number, manager: EntityManager): Promise<Machine | null> {
    return this.repo(manager)
      .createQueryBuilder('machine')
      .setLock('pessimistic_write')
      .where('machine.id = :id', { id })
      .getOne();
  }

  /** As findByIdForUpdate, but also returns soft-deleted machines (their historical logs stay editable). */
  findByIdForUpdateIncludingDeleted(id: number, manager: EntityManager): Promise<Machine | null> {
    return this.repo(manager)
      .createQueryBuilder('machine')
      .withDeleted()
      .setLock('pessimistic_write')
      .where('machine.id = :id', { id })
      .getOne();
  }

  /**
   * The only write path for machine status. Must be called inside the
   * transaction that holds the machine lock and records the causing log.
   */
  async updateStatus(id: number, status: MachineState, manager: EntityManager): Promise<void> {
    await this.repo(manager)
      .createQueryBuilder()
      .update(Machine)
      .set({ status })
      .where('id = :id', { id })
      .execute();
  }

  async serialNumberExists(serialNumber: string, excludeId?: number): Promise<boolean> {
    const query = this.repo()
      .createQueryBuilder('machine')
      .withDeleted()
      .where('machine.serialNumber = :serialNumber', { serialNumber });
    if (excludeId !== undefined) query.andWhere('machine.id <> :excludeId', { excludeId });
    return (await query.getCount()) > 0;
  }

  async findPage(
    filters: MachineFilters,
    sort: { sortBy: MachineSortField; sortOrder: 'asc' | 'desc' },
    page: PageRequest,
  ): Promise<Page<Machine>> {
    const query = this.repo().createQueryBuilder('machine');
    if (filters.status) query.andWhere('machine.status = :status', { status: filters.status });
    if (filters.isActive !== undefined)
      query.andWhere('machine.isActive = :isActive', { isActive: filters.isActive });
    if (filters.search) {
      query.andWhere(
        "(machine.name ILIKE :search ESCAPE '\\' OR machine.serialNumber ILIKE :search ESCAPE '\\')",
        { search: `%${escapeLikePattern(filters.search)}%` },
      );
    }
    const direction = sort.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const [items, total] = await query
      .orderBy(`machine.${sort.sortBy}`, direction)
      .addOrderBy('machine.id', direction)
      .skip(toOffset(page))
      .take(page.limit)
      .getManyAndCount();
    return buildPage(items, total, page);
  }

  /** Log counts and last activity for the given machines (deleted logs excluded). */
  async activitySummaries(machineIds: readonly number[]): Promise<Map<number, MachineActivitySummary>> {
    const summaries = new Map<number, MachineActivitySummary>();
    if (machineIds.length === 0) return summaries;

    const rows = await this.dataSource.manager
      .getRepository(MachineLog)
      .createQueryBuilder('log')
      .select('log.machineId', 'machineId')
      .addSelect('COUNT(*)::int', 'totalLogs')
      .addSelect('COUNT(*) FILTER (WHERE log.logStatus = :open)::int', 'openLogs')
      .addSelect('MAX(log.createdAt)', 'lastActivityAt')
      .where('log.machineId IN (:...machineIds)', { machineIds })
      .setParameter('open', LogStatus.OPEN)
      .groupBy('log.machineId')
      .getRawMany<{ machineId: number; totalLogs: number; openLogs: number; lastActivityAt: Date | null }>();

    for (const row of rows) {
      summaries.set(row.machineId, {
        totalLogs: row.totalLogs,
        openLogs: row.openLogs,
        lastActivityAt: row.lastActivityAt,
      });
    }
    return summaries;
  }

  async countOpenLogs(machineId: number, manager: EntityManager): Promise<number> {
    return manager.getRepository(MachineLog).count({ where: { machineId, logStatus: LogStatus.OPEN } });
  }

  async softDelete(machineId: number, manager: EntityManager): Promise<void> {
    await this.repo(manager).update({ id: machineId }, { isActive: false });
    await this.repo(manager).softDelete({ id: machineId });
  }
}
