import { type EntityManager } from 'typeorm';
import { AuditAction, AuditEntity } from '../audit/audit.constants';
import { type AuditService } from '../audit/audit.service';
import { diffValues } from '../audit/audit-sanitizer';
import { type AuthenticatedUser } from '../auth/auth.types';
import { type TransactionRunner } from '../common/database/transaction-runner';
import { MachineState } from '../common/enums/machine-state.enum';
import { OperationalImpact } from '../common/enums/operational-impact.enum';
import { AppError } from '../common/errors/app-error';
import { isUniqueViolation } from '../common/errors/database-errors';
import { ErrorCode } from '../common/errors/error-codes';
import { type RequestMeta } from '../common/http/request-meta';
import { type Page } from '../common/pagination/pagination';
import { type Clock } from '../common/utils/clock';
import { type MachineLogsRepository } from '../machine-logs/machine-logs.repository';
import { type Machine } from '../machines/machine.entity';
import { type MachineStatusSynchronizer } from '../machines/machine-status.synchronizer';
import { type MachinesRepository } from '../machines/machines.repository';
import { type MaintenanceSchedule } from '../maintenance/maintenance-schedule.entity';
import { type MaintenanceRepository } from '../maintenance/maintenance.repository';
import { type MachinePart } from './machine-part.entity';
import { toMachinePartAuditSnapshot } from './machine-part.mapper';
import {
  type CreateMachinePartDto,
  type ListMachinePartsQuery,
  type UpdateMachinePartDto,
} from './machine-parts.dto';
import { type MachinePartsRepository } from './machine-parts.repository';

const PART_CODE_EXISTS_MESSAGE = 'A part with this code already exists on this machine';

/**
 * Machine parts (master data). Part status changes only through part-scope
 * machine logs (see MachineLogsService); every change here that can affect the
 * machine (adding, deactivating or deleting a part, changing criticality) asks
 * MachineStatusSynchronizer to re-derive the machine status in the same
 * transaction. Removing or deactivating a part also deactivates its
 * maintenance schedules, so no reminders are sent for it.
 */
export class MachinePartsService {
  constructor(
    private readonly parts: MachinePartsRepository,
    private readonly logs: MachineLogsRepository,
    private readonly machines: MachinesRepository,
    private readonly statusSync: MachineStatusSynchronizer,
    private readonly transactions: TransactionRunner,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly maintenance: MaintenanceRepository,
  ) {}

  // ---------------------------------------------------------------- parts (ADMIN)

  async createPart(
    machineId: number,
    dto: CreateMachinePartDto,
    actor: AuthenticatedUser,
    meta: RequestMeta,
  ): Promise<MachinePart> {
    if (await this.parts.partCodeExists(machineId, dto.partCode)) {
      throw AppError.conflict(PART_CODE_EXISTS_MESSAGE, ErrorCode.MACHINE_PART_CODE_EXISTS);
    }
    const now = this.clock.now();

    const { partId, statusChange } = await this.withPartCodeConflictMapping(() =>
      this.transactions.run(async (manager) => {
        const machine = await this.requireActiveMachine(machineId, manager);
        const status = dto.status;
        const operationalImpact = this.resolveImpact(status, dto.operationalImpact, dto.isCritical);

        const part = await this.parts.save(
          this.parts.create({
            machineId: machine.id,
            name: dto.name,
            partCode: dto.partCode,
            description: dto.description ?? null,
            status,
            operationalImpact,
            isCritical: dto.isCritical,
            isActive: true,
          }),
          manager,
        );
        await this.audit.record(
          {
            action: AuditAction.MACHINE_PART_CREATED,
            entity: AuditEntity.MACHINE_PART,
            entityId: part.id,
            actorId: actor.id,
            newValues: toMachinePartAuditSnapshot(part),
            meta,
          },
          manager,
        );
        const change = await this.statusSync.synchronize({
          machine,
          trigger: { type: 'MACHINE_PART', partId: part.id },
          actor,
          meta,
          manager,
        });
        return { partId: part.id, statusChange: change };
      }),
    );

    this.statusSync.publish(statusChange, actor, now);
    return this.getPart(machineId, partId);
  }

  async listParts(machineId: number, query: ListMachinePartsQuery): Promise<Page<MachinePart>> {
    await this.requireMachine(machineId);
    return this.parts.findPage(
      {
        machineId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.isCritical !== undefined ? { isCritical: query.isCritical } : {}),
        ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
        ...(query.search ? { search: query.search } : {}),
      },
      { sortBy: query.sortBy, sortOrder: query.sortOrder },
      { page: query.page, limit: query.limit },
    );
  }

  /** The earliest-due active maintenance schedule of each part, keyed by part id. */
  nextMaintenanceFor(parts: readonly MachinePart[]): Promise<Map<number, MaintenanceSchedule>> {
    return this.maintenance.findNextSchedulesForParts(parts.map((part) => part.id));
  }

  async getPart(machineId: number, partId: number): Promise<MachinePart> {
    const part = await this.parts.findById(partId);
    if (part?.machineId !== machineId) {
      throw AppError.notFound('Machine part not found', ErrorCode.MACHINE_PART_NOT_FOUND);
    }
    return part;
  }

  /**
   * Updates part master data. Status and impact are not accepted here; changing
   * criticality or deactivating a part can still change the machine's status,
   * so it is recalculated.
   */
  async updatePart(
    machineId: number,
    partId: number,
    dto: UpdateMachinePartDto,
    actor: AuthenticatedUser,
    meta: RequestMeta,
  ): Promise<MachinePart> {
    if (dto.partCode !== undefined && (await this.parts.partCodeExists(machineId, dto.partCode, partId))) {
      throw AppError.conflict(PART_CODE_EXISTS_MESSAGE, ErrorCode.MACHINE_PART_CODE_EXISTS);
    }
    const now = this.clock.now();

    const statusChange = await this.withPartCodeConflictMapping(() =>
      this.transactions.run(async (manager) => {
        const machine = await this.requireMachineForUpdate(machineId, manager);
        const part = await this.requirePartForUpdate(machineId, partId, manager);
        const before = toMachinePartAuditSnapshot(part);

        if (dto.name !== undefined) part.name = dto.name;
        if (dto.partCode !== undefined) part.partCode = dto.partCode;
        if (dto.description !== undefined) part.description = dto.description;
        if (dto.isCritical !== undefined) part.isCritical = dto.isCritical;
        if (dto.isActive !== undefined) part.isActive = dto.isActive;

        const { oldValues, newValues } = diffValues(before, toMachinePartAuditSnapshot(part));
        if (Object.keys(newValues).length === 0) return null;

        await this.parts.save(part, manager);
        await this.audit.record(
          {
            action: AuditAction.MACHINE_PART_UPDATED,
            entity: AuditEntity.MACHINE_PART,
            entityId: part.id,
            actorId: actor.id,
            oldValues,
            newValues,
            meta,
          },
          manager,
        );
        if (!part.isActive) await this.deactivateSchedules(part.id, actor, meta, manager);
        return this.statusSync.synchronize({
          machine,
          trigger: { type: 'MACHINE_PART', partId: part.id },
          actor,
          meta,
          manager,
        });
      }),
    );

    this.statusSync.publish(statusChange, actor, now);
    return this.getPart(machineId, partId);
  }

  /** Soft-deletes a part. Refused while the part has open logs. */
  async removePart(
    machineId: number,
    partId: number,
    actor: AuthenticatedUser,
    meta: RequestMeta,
  ): Promise<void> {
    const now = this.clock.now();
    const statusChange = await this.transactions.run(async (manager) => {
      const machine = await this.requireMachineForUpdate(machineId, manager);
      const part = await this.requirePartForUpdate(machineId, partId, manager);

      const openLogs = await this.logs.countOpenForPart(part.id, manager);
      if (openLogs > 0) {
        throw AppError.conflict(
          `Part has ${openLogs} open log(s); close them before deleting the part`,
          ErrorCode.MACHINE_PART_HAS_OPEN_LOGS,
        );
      }

      await this.parts.softDelete(part.id, manager);
      await this.audit.record(
        {
          action: AuditAction.MACHINE_PART_DELETED,
          entity: AuditEntity.MACHINE_PART,
          entityId: part.id,
          actorId: actor.id,
          oldValues: toMachinePartAuditSnapshot(part),
          meta,
        },
        manager,
      );
      await this.deactivateSchedules(part.id, actor, meta, manager);
      return this.statusSync.synchronize({
        machine,
        trigger: { type: 'MACHINE_PART', partId: part.id },
        actor,
        meta,
        manager,
      });
    });

    this.statusSync.publish(statusChange, actor, now);
  }

  // ------------------------------------------------------------------- internals

  private async deactivateSchedules(
    partId: number,
    actor: AuthenticatedUser,
    meta: RequestMeta,
    manager: EntityManager,
  ): Promise<void> {
    const scheduleIds = await this.maintenance.deactivateSchedulesForPart(partId, manager);
    for (const scheduleId of scheduleIds) {
      await this.audit.record(
        {
          action: AuditAction.MAINTENANCE_SCHEDULE_UPDATED,
          entity: AuditEntity.MAINTENANCE_SCHEDULE,
          entityId: scheduleId,
          actorId: actor.id,
          oldValues: { isActive: true },
          newValues: { isActive: false, machinePartId: partId },
          meta,
        },
        manager,
      );
    }
  }

  /** A part that is ACTIVE never blocks; otherwise the explicit impact wins, then criticality. */
  private resolveImpact(
    status: MachineState,
    requested: OperationalImpact | undefined,
    isCritical: boolean,
  ): OperationalImpact {
    if (status === MachineState.ACTIVE) return OperationalImpact.NON_BLOCKING;
    return requested ?? (isCritical ? OperationalImpact.BLOCKING : OperationalImpact.NON_BLOCKING);
  }

  private async requireMachine(machineId: number): Promise<Machine> {
    const machine = await this.machines.findById(machineId);
    if (!machine) throw AppError.notFound('Machine not found', ErrorCode.MACHINE_NOT_FOUND);
    return machine;
  }

  private async requireMachineForUpdate(machineId: number, manager: EntityManager): Promise<Machine> {
    const machine = await this.machines.findByIdForUpdate(machineId, manager);
    if (!machine) throw AppError.notFound('Machine not found', ErrorCode.MACHINE_NOT_FOUND);
    return machine;
  }

  private async requireActiveMachine(machineId: number, manager: EntityManager): Promise<Machine> {
    const machine = await this.requireMachineForUpdate(machineId, manager);
    if (!machine.isActive) {
      throw AppError.unprocessable(
        'Parts cannot be changed on a deactivated machine',
        ErrorCode.MACHINE_INACTIVE,
      );
    }
    return machine;
  }

  private async requirePartForUpdate(
    machineId: number,
    partId: number,
    manager: EntityManager,
  ): Promise<MachinePart> {
    const part = await this.parts.findByIdForUpdate(partId, manager);
    if (part?.machineId !== machineId) {
      throw AppError.notFound('Machine part not found', ErrorCode.MACHINE_PART_NOT_FOUND);
    }
    return part;
  }

  private async withPartCodeConflictMapping<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error: unknown) {
      if (isUniqueViolation(error, 'UQ_machine_parts_machine_id_part_code')) {
        throw AppError.conflict(PART_CODE_EXISTS_MESSAGE, ErrorCode.MACHINE_PART_CODE_EXISTS);
      }
      throw error;
    }
  }
}
