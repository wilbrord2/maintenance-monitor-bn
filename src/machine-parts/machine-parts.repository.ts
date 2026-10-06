import { type DataSource, type EntityManager } from 'typeorm';
import { MachineState } from '../common/enums/machine-state.enum';
import { OperationalImpact } from '../common/enums/operational-impact.enum';
import {
  buildPage,
  escapeLikePattern,
  toOffset,
  type Page,
  type PageRequest,
} from '../common/pagination/pagination';
import { type PartCondition } from '../machines/machine-status.resolver';
import { type PartConditionReader } from '../machines/machine-status.synchronizer';
import { MachinePart } from './machine-part.entity';

export const MACHINE_PART_SORT_FIELDS = ['partCode', 'name', 'status', 'createdAt', 'updatedAt'] as const;
export type MachinePartSortField = (typeof MACHINE_PART_SORT_FIELDS)[number];

export interface MachinePartFilters {
  readonly machineId?: number;
  readonly status?: MachineState;
  readonly isCritical?: boolean;
  readonly isActive?: boolean;
  readonly search?: string;
}

export interface MachinePartSummary {
  readonly total: number;
  readonly active: number;
  readonly underMaintenance: number;
  readonly downtime: number;
  readonly underTest: number;
  readonly blocking: number;
  readonly critical: number;
}

export const EMPTY_PART_SUMMARY: MachinePartSummary = {
  total: 0,
  active: 0,
  underMaintenance: 0,
  downtime: 0,
  underTest: 0,
  blocking: 0,
  critical: 0,
};

export class MachinePartsRepository implements PartConditionReader {
  constructor(private readonly dataSource: DataSource) {}

  private repo(manager?: EntityManager) {
    return (manager ?? this.dataSource.manager).getRepository(MachinePart);
  }

  create(values: Partial<MachinePart>): MachinePart {
    return this.repo().create(values);
  }

  save(part: MachinePart, manager?: EntityManager): Promise<MachinePart> {
    return this.repo(manager).save(part);
  }

  findById(id: number, manager?: EntityManager): Promise<MachinePart | null> {
    return this.repo(manager).findOne({ where: { id } });
  }

  /** Locks the part row. Callers must already hold the machine lock (machine first, then part). */
  findByIdForUpdate(id: number, manager: EntityManager): Promise<MachinePart | null> {
    return this.repo(manager)
      .createQueryBuilder('part')
      .setLock('pessimistic_write')
      .where('part.id = :id', { id })
      .getOne();
  }

  /**
   * Part conditions feeding MachineStatusResolver: every non-deleted part of the
   * machine (the resolver itself ignores deactivated ones).
   */
  async conditionsForMachine(machineId: number, manager?: EntityManager): Promise<PartCondition[]> {
    const parts = await this.repo(manager)
      .createQueryBuilder('part')
      .select(['part.id', 'part.partCode', 'part.status', 'part.operationalImpact', 'part.isActive'])
      .where('part.machineId = :machineId', { machineId })
      .orderBy('part.partCode', 'ASC')
      .getMany();
    return parts.map((part) => ({
      id: part.id,
      partCode: part.partCode,
      status: part.status,
      operationalImpact: part.operationalImpact,
      isActive: part.isActive,
    }));
  }

  async partCodeExists(machineId: number, partCode: string, excludeId?: number): Promise<boolean> {
    const query = this.repo()
      .createQueryBuilder('part')
      .withDeleted()
      .where('part.machineId = :machineId AND part.partCode = :partCode', { machineId, partCode });
    if (excludeId !== undefined) query.andWhere('part.id <> :excludeId', { excludeId });
    return (await query.getCount()) > 0;
  }

  findByMachine(machineId: number, manager?: EntityManager): Promise<MachinePart[]> {
    return this.repo(manager).find({ where: { machineId }, order: { partCode: 'ASC' } });
  }

  async findPage(
    filters: MachinePartFilters,
    sort: { sortBy: MachinePartSortField; sortOrder: 'asc' | 'desc' },
    page: PageRequest,
  ): Promise<Page<MachinePart>> {
    const query = this.repo().createQueryBuilder('part');
    if (filters.machineId !== undefined) {
      query.andWhere('part.machineId = :machineId', { machineId: filters.machineId });
    }
    if (filters.status) query.andWhere('part.status = :status', { status: filters.status });
    if (filters.isCritical !== undefined) {
      query.andWhere('part.isCritical = :isCritical', { isCritical: filters.isCritical });
    }
    if (filters.isActive !== undefined) {
      query.andWhere('part.isActive = :isActive', { isActive: filters.isActive });
    }
    if (filters.search) {
      query.andWhere("(part.name ILIKE :search ESCAPE '\\' OR part.partCode ILIKE :search ESCAPE '\\')", {
        search: `%${escapeLikePattern(filters.search)}%`,
      });
    }
    const direction = sort.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const [items, total] = await query
      .orderBy(`part.${sort.sortBy}`, direction)
      .addOrderBy('part.id', direction)
      .skip(toOffset(page))
      .take(page.limit)
      .getManyAndCount();
    return buildPage(items, total, page);
  }

  /** Part status counts per machine, for machine details and analytics. */
  async summariesByMachine(machineIds: readonly number[]): Promise<Map<number, MachinePartSummary>> {
    const summaries = new Map<number, MachinePartSummary>();
    if (machineIds.length === 0) return summaries;

    const rows = await this.repo()
      .createQueryBuilder('part')
      .select('part.machineId', 'machineId')
      .addSelect('COUNT(*)::int', 'total')
      .addSelect(`COUNT(*) FILTER (WHERE part.status = :active)::int`, 'active')
      .addSelect(`COUNT(*) FILTER (WHERE part.status = :maintenance)::int`, 'underMaintenance')
      .addSelect(`COUNT(*) FILTER (WHERE part.status = :downtime)::int`, 'downtime')
      .addSelect(`COUNT(*) FILTER (WHERE part.status = :test)::int`, 'underTest')
      .addSelect(
        `COUNT(*) FILTER (WHERE part.status <> :active AND part.operationalImpact = :blocking)::int`,
        'blocking',
      )
      .addSelect('COUNT(*) FILTER (WHERE part.isCritical)::int', 'critical')
      .where('part.machineId IN (:...machineIds)', { machineIds })
      .andWhere('part.isActive = true')
      .setParameters({
        active: MachineState.ACTIVE,
        maintenance: MachineState.UNDER_MAINTENANCE,
        downtime: MachineState.DOWNTIME,
        test: MachineState.UNDER_TEST,
        blocking: OperationalImpact.BLOCKING,
      })
      .groupBy('part.machineId')
      .getRawMany<MachinePartSummary & { machineId: number }>();

    for (const row of rows) {
      summaries.set(row.machineId, {
        total: row.total,
        active: row.active,
        underMaintenance: row.underMaintenance,
        downtime: row.downtime,
        underTest: row.underTest,
        blocking: row.blocking,
        critical: row.critical,
      });
    }
    return summaries;
  }

  /** Applies a new condition. Only called from the part-log transaction. */
  async updateCondition(
    id: number,
    condition: { status: MachineState; operationalImpact: OperationalImpact },
    manager: EntityManager,
  ): Promise<void> {
    await this.repo(manager)
      .createQueryBuilder()
      .update(MachinePart)
      .set({ status: condition.status, operationalImpact: condition.operationalImpact })
      .where('id = :id', { id })
      .execute();
  }

  async softDelete(id: number, manager: EntityManager): Promise<void> {
    await this.repo(manager).update({ id }, { isActive: false });
    await this.repo(manager).softDelete({ id });
  }
}
