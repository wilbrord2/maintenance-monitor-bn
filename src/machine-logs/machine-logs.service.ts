import { type EntityManager } from 'typeorm';
import { AuditAction, AuditEntity } from '../audit/audit.constants';
import { type AuditService } from '../audit/audit.service';
import { diffValues } from '../audit/audit-sanitizer';
import { type AuthenticatedUser } from '../auth/auth.types';
import { type TransactionRunner } from '../common/database/transaction-runner';
import { LogStatus } from '../common/enums/log-status.enum';
import { type MachineState } from '../common/enums/machine-state.enum';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { type DomainEventBus } from '../common/events/domain-event-bus';
import { MACHINE_STATUS_UPDATED, type MachineStatusChangeSource } from '../common/events/domain-events';
import { type RequestMeta } from '../common/http/request-meta';
import { type Page } from '../common/pagination/pagination';
import { type Clock } from '../common/utils/clock';
import { endOfUtcDayExclusive, startOfUtcDay } from '../common/utils/date-range';
import { type Machine } from '../machines/machine.entity';
import { type MachinesRepository } from '../machines/machines.repository';
import { type MachineLog } from './machine-log.entity';
import { toMachineLogAuditSnapshot } from './machine-log.mapper';
import {
  type CreateMachineLogDto,
  type ListMachineLogsQuery,
  type MachineHistoryQuery,
  type UpdateMachineLogDto,
} from './machine-logs.dto';
import { type MachineLogFilters, type MachineLogsRepository } from './machine-logs.repository';
import { type DowntimeCalculator } from './policies/downtime-calculator';
import { type MachineLogRules } from './policies/machine-log-rules.policy';
import { type MachineStateTransitionPolicy } from './policies/machine-state-transition.policy';

interface LogFilterQuery {
  readonly machineId?: number | undefined;
  readonly userId?: number | undefined;
  readonly entryStatus?: MachineState | undefined;
  readonly resultingState?: MachineState | undefined;
  readonly logStatus?: LogStatus | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly search?: string | undefined;
}

interface StatusChange {
  readonly machine: Machine;
  readonly previousStatus: MachineState;
  readonly newStatus: MachineState;
  readonly logId: number;
  readonly source: MachineStatusChangeSource;
}

/**
 * Owns machine logs and, through them, machine status.
 *
 * Invariant: a machine's status equals the resulting state of its most recent
 * log. Every operation that can affect status runs in one transaction that
 * (1) locks the machine row, (2) validates against the locked state,
 * (3) writes the log, (4) writes the status and (5) writes audit entries.
 * Any failure rolls back all of it. Status events are published after commit.
 */
export class MachineLogsService {
  constructor(
    private readonly logs: MachineLogsRepository,
    private readonly machines: MachinesRepository,
    private readonly transitions: MachineStateTransitionPolicy,
    private readonly rules: MachineLogRules,
    private readonly downtime: DowntimeCalculator,
    private readonly transactions: TransactionRunner,
    private readonly audit: AuditService,
    private readonly events: DomainEventBus,
    private readonly clock: Clock,
  ) {}

  async create(dto: CreateMachineLogDto, actor: AuthenticatedUser, meta: RequestMeta): Promise<MachineLog> {
    const now = this.clock.now();

    const { logId, statusChange } = await this.transactions.run(async (manager) => {
      const machine = await this.machines.findByIdForUpdate(dto.machineId, manager);
      if (!machine) throw AppError.notFound('Machine not found', ErrorCode.MACHINE_NOT_FOUND);
      if (!machine.isActive) {
        throw AppError.unprocessable(
          'Logs cannot be recorded for a deactivated machine',
          ErrorCode.MACHINE_INACTIVE,
        );
      }
      this.assertExpectedState(machine, dto.entryStatus);
      this.transitions.assertAllowed(dto.entryStatus, dto.resultingState);

      const startedAt = dto.startedAt ?? now;
      const endedAt = dto.logStatus === LogStatus.CLOSED ? (dto.endedAt ?? now) : (dto.endedAt ?? null);
      this.rules.validate(
        {
          resultingState: dto.resultingState,
          logStatus: dto.logStatus,
          startedAt,
          endedAt,
          downtimeHours: dto.downtimeHours,
        },
        { isLatest: true, now },
      );

      const log = await this.logs.save(
        this.logs.create({
          machineId: machine.id,
          userId: actor.id,
          faultDescription: dto.faultDescription,
          causeDescription: dto.causeDescription ?? null,
          entryStatus: dto.entryStatus,
          remedyAction: dto.remedyAction ?? null,
          resultingState: dto.resultingState,
          downtimeHours: this.downtime.resolve({ explicitHours: dto.downtimeHours, startedAt, endedAt }),
          logStatus: dto.logStatus,
          nextMaintenancePlan: dto.nextMaintenancePlan ?? null,
          startedAt,
          endedAt,
          version: 1,
        }),
        manager,
      );

      await this.audit.record(
        {
          action: AuditAction.MACHINE_LOG_CREATED,
          entity: AuditEntity.MACHINE_LOG,
          entityId: log.id,
          actorId: actor.id,
          newValues: toMachineLogAuditSnapshot(log),
          meta,
        },
        manager,
      );
      const change = await this.applyStatus(
        machine,
        dto.resultingState,
        log.id,
        'MACHINE_LOG_CREATED',
        actor,
        meta,
        manager,
      );
      return { logId: log.id, statusChange: change };
    });

    this.publishStatusChange(statusChange, actor, now);
    return this.getById(logId);
  }

  async update(
    id: number,
    dto: UpdateMachineLogDto,
    actor: AuthenticatedUser,
    meta: RequestMeta,
  ): Promise<MachineLog> {
    const existing = await this.getById(id);
    const now = this.clock.now();

    const statusChange = await this.transactions.run(async (manager) => {
      // Lock order: machine first, then log (same as create/delete) to avoid deadlocks.
      const machine = await this.machines.findByIdForUpdateIncludingDeleted(existing.machineId, manager);
      const log = await this.logs.findByIdForUpdate(id, manager);
      if (!machine || !log) throw AppError.notFound('Machine log not found', ErrorCode.MACHINE_LOG_NOT_FOUND);
      if (log.version !== dto.version) {
        throw AppError.conflict(
          'This log was modified by someone else. Reload it and try again.',
          ErrorCode.STALE_VERSION,
        );
      }

      const isLatest = (await this.logs.findLatestIdForMachine(machine.id, manager)) === log.id;
      const before = toMachineLogAuditSnapshot(log);
      const previousResultingState = log.resultingState;

      if (dto.resultingState !== undefined && dto.resultingState !== log.resultingState) {
        if (!isLatest) {
          throw AppError.conflict(
            "Only the machine's most recent log can change its resulting state",
            ErrorCode.RESULTING_STATE_IMMUTABLE,
          );
        }
        if (!machine.isActive || machine.deletedAt) {
          throw AppError.unprocessable(
            'The state of a deactivated machine cannot be changed',
            ErrorCode.MACHINE_INACTIVE,
          );
        }
        this.assertExpectedState(machine, log.resultingState);
        this.transitions.assertAllowed(log.entryStatus, dto.resultingState);
        log.resultingState = dto.resultingState;
      }

      if (dto.faultDescription !== undefined) log.faultDescription = dto.faultDescription;
      if (dto.causeDescription !== undefined) log.causeDescription = dto.causeDescription;
      if (dto.remedyAction !== undefined) log.remedyAction = dto.remedyAction;
      if (dto.nextMaintenancePlan !== undefined) log.nextMaintenancePlan = dto.nextMaintenancePlan;
      if (dto.startedAt !== undefined) log.startedAt = dto.startedAt;
      this.applyLogStatus(log, dto, now);

      this.rules.validate(
        {
          resultingState: log.resultingState,
          logStatus: log.logStatus,
          startedAt: log.startedAt,
          endedAt: log.endedAt,
          downtimeHours: dto.downtimeHours,
        },
        { isLatest, now },
      );

      // Downtime is recalculated when the event's timing changes (typically when it is closed).
      const timingChanged =
        dto.startedAt !== undefined || dto.endedAt !== undefined || dto.logStatus !== undefined;
      if (dto.downtimeHours !== undefined || timingChanged) {
        log.downtimeHours = this.downtime.resolve({
          explicitHours: dto.downtimeHours,
          startedAt: log.startedAt,
          endedAt: log.endedAt,
        });
      }

      const { oldValues, newValues } = diffValues(before, toMachineLogAuditSnapshot(log));
      if (Object.keys(newValues).length === 0) return null;

      log.version += 1;
      await this.logs.save(log, manager);
      await this.audit.record(
        {
          action: AuditAction.MACHINE_LOG_UPDATED,
          entity: AuditEntity.MACHINE_LOG,
          entityId: log.id,
          actorId: actor.id,
          oldValues,
          newValues: { ...newValues, version: log.version },
          meta,
        },
        manager,
      );

      return log.resultingState === previousResultingState
        ? null
        : this.applyStatus(machine, log.resultingState, log.id, 'MACHINE_LOG_UPDATED', actor, meta, manager);
    });

    this.publishStatusChange(statusChange, actor, now);
    return this.getById(id);
  }

  /**
   * Soft-deletes a log (ADMIN only). Deleting a machine's most recent log
   * reverts the machine to that log's entry status — the state it was in
   * immediately before the event, as verified when the log was created.
   */
  async remove(id: number, actor: AuthenticatedUser, meta: RequestMeta): Promise<void> {
    const existing = await this.getById(id);
    const now = this.clock.now();

    const statusChange = await this.transactions.run(async (manager) => {
      const machine = await this.machines.findByIdForUpdateIncludingDeleted(existing.machineId, manager);
      const log = await this.logs.findByIdForUpdate(id, manager);
      if (!machine || !log) throw AppError.notFound('Machine log not found', ErrorCode.MACHINE_LOG_NOT_FOUND);

      const isLatest = (await this.logs.findLatestIdForMachine(machine.id, manager)) === log.id;
      await this.logs.softDelete(log.id, manager);
      await this.audit.record(
        {
          action: AuditAction.MACHINE_LOG_DELETED,
          entity: AuditEntity.MACHINE_LOG,
          entityId: log.id,
          actorId: actor.id,
          oldValues: { ...toMachineLogAuditSnapshot(log), wasLatest: isLatest },
          meta,
        },
        manager,
      );

      return isLatest
        ? this.applyStatus(machine, log.entryStatus, log.id, 'MACHINE_LOG_DELETED', actor, meta, manager)
        : null;
    });

    this.publishStatusChange(statusChange, actor, now);
  }

  async getById(id: number): Promise<MachineLog> {
    const log = await this.logs.findById(id);
    if (!log) throw AppError.notFound('Machine log not found', ErrorCode.MACHINE_LOG_NOT_FOUND);
    return log;
  }

  list(query: ListMachineLogsQuery): Promise<Page<MachineLog>> {
    return this.logs.findPage(
      this.filtersFrom(query),
      { sortBy: query.sortBy, sortOrder: query.sortOrder },
      { page: query.page, limit: query.limit },
    );
  }

  async history(machineId: number, query: MachineHistoryQuery): Promise<Page<MachineLog>> {
    const machine = await this.machines.findById(machineId);
    if (!machine) throw AppError.notFound('Machine not found', ErrorCode.MACHINE_NOT_FOUND);
    return this.logs.findPage(
      { ...this.filtersFrom(query), machineId },
      { sortBy: query.sortBy, sortOrder: query.sortOrder },
      { page: query.page, limit: query.limit },
    );
  }

  describeRules() {
    return this.transitions.describe();
  }

  /** Optimistic expected-state check performed while holding the machine lock. */
  private assertExpectedState(machine: Machine, expected: MachineState): void {
    if (machine.status === expected) return;
    throw new AppError(
      409,
      ErrorCode.MACHINE_STATE_CONFLICT,
      `Machine status has changed to ${machine.status} (expected ${expected}). Reload the machine and try again.`,
      [{ field: 'entryStatus', message: `current machine status is ${machine.status}` }],
    );
  }

  private applyLogStatus(log: MachineLog, dto: UpdateMachineLogDto, now: Date): void {
    const targetStatus = dto.logStatus ?? log.logStatus;
    if (targetStatus === LogStatus.OPEN) {
      // Re-opening clears the end time unless the client explicitly (and invalidly) sends one.
      log.endedAt = dto.endedAt ?? (dto.logStatus === LogStatus.OPEN ? null : log.endedAt);
    } else if (dto.endedAt !== undefined) {
      log.endedAt = dto.endedAt;
    } else if (log.logStatus === LogStatus.OPEN) {
      log.endedAt = now;
    }
    log.logStatus = targetStatus;
  }

  private async applyStatus(
    machine: Machine,
    newStatus: MachineState,
    logId: number,
    source: MachineStatusChangeSource,
    actor: AuthenticatedUser,
    meta: RequestMeta,
    manager: EntityManager,
  ): Promise<StatusChange | null> {
    const previousStatus = machine.status;
    if (previousStatus === newStatus) return null;

    await this.machines.updateStatus(machine.id, newStatus, manager);
    machine.status = newStatus;
    await this.audit.record(
      {
        action: AuditAction.MACHINE_STATUS_CHANGED,
        entity: AuditEntity.MACHINE,
        entityId: machine.id,
        actorId: actor.id,
        oldValues: { status: previousStatus },
        newValues: { status: newStatus, logId, source },
        meta,
      },
      manager,
    );
    return { machine, previousStatus, newStatus, logId, source };
  }

  private publishStatusChange(change: StatusChange | null, actor: AuthenticatedUser, at: Date): void {
    if (!change) return;
    this.events.publish(MACHINE_STATUS_UPDATED, {
      machineId: change.machine.id,
      machineName: change.machine.name,
      serialNumber: change.machine.serialNumber,
      previousStatus: change.previousStatus,
      newStatus: change.newStatus,
      updatedBy: { id: actor.id, name: actor.name },
      logId: change.logId,
      source: change.source,
      timestamp: at.toISOString(),
    });
  }

  private filtersFrom(query: LogFilterQuery): MachineLogFilters {
    return {
      ...(query.machineId !== undefined ? { machineId: query.machineId } : {}),
      ...(query.userId !== undefined ? { userId: query.userId } : {}),
      ...(query.entryStatus ? { entryStatus: query.entryStatus } : {}),
      ...(query.resultingState ? { resultingState: query.resultingState } : {}),
      ...(query.logStatus ? { logStatus: query.logStatus } : {}),
      ...(query.from ? { from: startOfUtcDay(query.from) } : {}),
      ...(query.to ? { to: endOfUtcDayExclusive(query.to) } : {}),
      ...(query.search ? { search: query.search } : {}),
    };
  }
}
