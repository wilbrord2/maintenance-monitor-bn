import { type EntityManager } from 'typeorm';
import { AuditAction, AuditEntity } from '../audit/audit.constants';
import { type AuditService } from '../audit/audit.service';
import { diffValues } from '../audit/audit-sanitizer';
import { type AuthenticatedUser } from '../auth/auth.types';
import { type TransactionRunner } from '../common/database/transaction-runner';
import { MachineState } from '../common/enums/machine-state.enum';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { isUniqueViolation } from '../common/errors/database-errors';
import { type RequestMeta } from '../common/http/request-meta';
import { type Page } from '../common/pagination/pagination';
import { type MachinePart } from '../machine-parts/machine-part.entity';
import {
  EMPTY_PART_SUMMARY,
  type MachinePartSummary,
  type MachinePartsRepository,
} from '../machine-parts/machine-parts.repository';
import { type MaintenanceSchedule } from '../maintenance/maintenance-schedule.entity';
import { type MaintenanceRepository } from '../maintenance/maintenance.repository';
import { type Machine } from './machine.entity';
import { toMachineAuditSnapshot } from './machine.mapper';
import { type CreateMachineDto, type ListMachinesQuery, type UpdateMachineDto } from './machines.dto';
import { EMPTY_ACTIVITY, type MachineActivitySummary, type MachinesRepository } from './machines.repository';

export interface MachineWithActivity {
  readonly machine: Machine;
  readonly activity: MachineActivitySummary;
  readonly partSummary: MachinePartSummary;
}

/** Everything the frontend needs to render one machine, including its parts and plan. */
export interface MachineDetail extends MachineWithActivity {
  readonly parts: readonly MachinePart[];
  readonly schedule: MaintenanceSchedule | null;
}

const SERIAL_EXISTS_MESSAGE = 'Machine serial number already exists';

/**
 * Machine master data. Deliberately exposes no way to set `status`: the system
 * status changes only through machine logs (MachineLogsService), and the
 * effective status is derived from it and the parts (MachineStatusSynchronizer).
 */
export class MachinesService {
  constructor(
    private readonly machines: MachinesRepository,
    private readonly transactions: TransactionRunner,
    private readonly audit: AuditService,
    private readonly parts: MachinePartsRepository,
    private readonly maintenance: MaintenanceRepository,
  ) {}

  async create(dto: CreateMachineDto, actor: AuthenticatedUser, meta: RequestMeta): Promise<Machine> {
    if (await this.machines.serialNumberExists(dto.serialNumber)) {
      throw AppError.conflict(SERIAL_EXISTS_MESSAGE, ErrorCode.MACHINE_SERIAL_EXISTS);
    }
    return this.withSerialConflictMapping(() =>
      this.transactions.run(async (manager) => {
        const machine = await this.machines.save(
          this.machines.create({
            name: dto.name,
            serialNumber: dto.serialNumber,
            description: dto.description ?? null,
            status: MachineState.ACTIVE,
            systemStatus: MachineState.ACTIVE,
            isActive: true,
          }),
          manager,
        );
        await this.audit.record(
          {
            action: AuditAction.MACHINE_CREATED,
            entity: AuditEntity.MACHINE,
            entityId: machine.id,
            actorId: actor.id,
            newValues: toMachineAuditSnapshot(machine),
            meta,
          },
          manager,
        );
        return machine;
      }),
    );
  }

  async list(query: ListMachinesQuery): Promise<Page<MachineWithActivity>> {
    const page = await this.machines.findPage(
      {
        ...(query.status ? { status: query.status } : {}),
        ...(query.operationalStatus ? { operationalStatus: query.operationalStatus } : {}),
        ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
        ...(query.search ? { search: query.search } : {}),
      },
      { sortBy: query.sortBy, sortOrder: query.sortOrder },
      { page: query.page, limit: query.limit },
    );
    const machineIds = page.items.map((machine) => machine.id);
    const [activity, partSummaries] = await Promise.all([
      this.machines.activitySummaries(machineIds),
      this.parts.summariesByMachine(machineIds),
    ]);
    return {
      items: page.items.map((machine) => ({
        machine,
        activity: activity.get(machine.id) ?? EMPTY_ACTIVITY,
        partSummary: partSummaries.get(machine.id) ?? EMPTY_PART_SUMMARY,
      })),
      meta: page.meta,
    };
  }

  /** Machine details with the part conditions its status was derived from and its maintenance plan. */
  async getById(id: number): Promise<MachineDetail> {
    const machine = await this.machines.findById(id);
    if (!machine) throw AppError.notFound('Machine not found', ErrorCode.MACHINE_NOT_FOUND);
    const [activity, partSummaries, parts, schedule] = await Promise.all([
      this.machines.activitySummaries([id]),
      this.parts.summariesByMachine([id]),
      this.parts.findByMachine(id),
      this.maintenance.findScheduleByMachine(id),
    ]);
    return {
      machine,
      activity: activity.get(id) ?? EMPTY_ACTIVITY,
      partSummary: partSummaries.get(id) ?? EMPTY_PART_SUMMARY,
      parts,
      schedule,
    };
  }

  async update(
    id: number,
    dto: UpdateMachineDto,
    actor: AuthenticatedUser,
    meta: RequestMeta,
  ): Promise<Machine> {
    if (dto.serialNumber !== undefined && (await this.machines.serialNumberExists(dto.serialNumber, id))) {
      throw AppError.conflict(SERIAL_EXISTS_MESSAGE, ErrorCode.MACHINE_SERIAL_EXISTS);
    }
    return this.withSerialConflictMapping(() =>
      this.transactions.run(async (manager) => {
        const machine = await this.getForUpdate(id, manager);
        const before = toMachineAuditSnapshot(machine);

        if (dto.name !== undefined) machine.name = dto.name;
        if (dto.serialNumber !== undefined) machine.serialNumber = dto.serialNumber;
        if (dto.description !== undefined) machine.description = dto.description;

        const { oldValues, newValues } = diffValues(before, toMachineAuditSnapshot(machine));
        if (Object.keys(newValues).length === 0) return machine;

        await this.machines.save(machine, manager);
        await this.audit.record(
          {
            action: AuditAction.MACHINE_UPDATED,
            entity: AuditEntity.MACHINE,
            entityId: machine.id,
            actorId: actor.id,
            oldValues,
            newValues,
            meta,
          },
          manager,
        );
        return machine;
      }),
    );
  }

  async setActive(
    id: number,
    isActive: boolean,
    actor: AuthenticatedUser,
    meta: RequestMeta,
  ): Promise<Machine> {
    return this.transactions.run(async (manager) => {
      const machine = await this.getForUpdate(id, manager);
      if (machine.isActive === isActive) return machine;

      machine.isActive = isActive;
      await this.machines.save(machine, manager);
      await this.audit.record(
        {
          action: isActive ? AuditAction.MACHINE_ACTIVATED : AuditAction.MACHINE_DEACTIVATED,
          entity: AuditEntity.MACHINE,
          entityId: machine.id,
          actorId: actor.id,
          oldValues: { isActive: !isActive },
          newValues: { isActive },
          meta,
        },
        manager,
      );
      return machine;
    });
  }

  /** Soft-deletes a machine. Refused while maintenance events are still open. */
  async remove(id: number, actor: AuthenticatedUser, meta: RequestMeta): Promise<void> {
    await this.transactions.run(async (manager) => {
      const machine = await this.getForUpdate(id, manager);
      const openLogs = await this.machines.countOpenLogs(machine.id, manager);
      if (openLogs > 0) {
        throw AppError.conflict(
          `Machine has ${openLogs} open maintenance log(s); close them before deleting the machine`,
          ErrorCode.MACHINE_HAS_OPEN_LOGS,
        );
      }
      await this.machines.softDelete(machine.id, manager);
      await this.audit.record(
        {
          action: AuditAction.MACHINE_DELETED,
          entity: AuditEntity.MACHINE,
          entityId: machine.id,
          actorId: actor.id,
          oldValues: toMachineAuditSnapshot(machine),
          meta,
        },
        manager,
      );
    });
  }

  private async getForUpdate(id: number, manager: EntityManager): Promise<Machine> {
    const machine = await this.machines.findByIdForUpdate(id, manager);
    if (!machine) throw AppError.notFound('Machine not found', ErrorCode.MACHINE_NOT_FOUND);
    return machine;
  }

  private async withSerialConflictMapping<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error: unknown) {
      if (isUniqueViolation(error, 'UQ_machines_serial_number')) {
        throw AppError.conflict(SERIAL_EXISTS_MESSAGE, ErrorCode.MACHINE_SERIAL_EXISTS);
      }
      throw error;
    }
  }
}
