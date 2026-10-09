import { type EntityManager } from 'typeorm';
import { AuditAction, AuditEntity } from '../audit/audit.constants';
import { type AuditService } from '../audit/audit.service';
import { diffValues } from '../audit/audit-sanitizer';
import { type AuthenticatedUser } from '../auth/auth.types';
import { type TransactionRunner } from '../common/database/transaction-runner';
import { LogScope } from '../common/enums/log-scope.enum';
import { LogStatus } from '../common/enums/log-status.enum';
import { MachineState } from '../common/enums/machine-state.enum';
import { OperationalImpact } from '../common/enums/operational-impact.enum';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { type DomainEventBus } from '../common/events/domain-event-bus';
import { MACHINE_PART_UPDATED } from '../common/events/domain-events';
import { type RequestMeta } from '../common/http/request-meta';
import { type Page } from '../common/pagination/pagination';
import { type Clock } from '../common/utils/clock';
import { endOfUtcDayExclusive, startOfUtcDay } from '../common/utils/date-range';
import { type MachinePart } from '../machine-parts/machine-part.entity';
import { type MachinePartsRepository } from '../machine-parts/machine-parts.repository';
import { type Machine } from '../machines/machine.entity';
import {
  type MachineStatusChange,
  type MachineStatusSynchronizer,
} from '../machines/machine-status.synchronizer';
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

type LogFilterQuery = Partial<
  Pick<
    MachineLogFilters,
    | 'machineId'
    | 'scope'
    | 'machinePartId'
    | 'operationalImpact'
    | 'userId'
    | 'entryStatus'
    | 'resultingState'
    | 'logStatus'
    | 'search'
  >
> & {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
};

/** What a log is about: the whole machine system, or one of its parts. */
interface LogSubject {
  readonly machine: Machine;
  /** Null for whole-machine logs. */
  readonly part: MachinePart | null;
}

interface PartChange {
  readonly part: MachinePart;
  readonly previousStatus: MachineState;
  readonly logId: number;
  readonly logStatus: LogStatus;
}

interface StatusChanges {
  readonly partChange: PartChange | null;
  readonly statusChange: MachineStatusChange | null;
}

const NO_CHANGES: StatusChanges = { partChange: null, statusChange: null };

/**
 * Owns every machine log — whole-machine and part — and, through them, the
 * machine's status.
 *
 * Invariants:
 * - a machine's `systemStatus` equals the resulting state of its most recent
 *   MACHINE-scope log;
 * - a part's status equals the resulting state of its most recent log;
 * - a machine's `status`/`operationalStatus` are re-derived from both by
 *   MachineStatusSynchronizer after every change, so they are never stale.
 *
 * Every operation runs in one transaction that (1) locks the machine, then the
 * part, (2) validates against the locked state, (3) writes the log, (4) applies
 * the subject's new state, (5) re-derives the machine status and (6) writes
 * audit entries. Any failure rolls back all of it. Events are published after
 * commit.
 */
export class MachineLogsService {
  constructor(
    private readonly logs: MachineLogsRepository,
    private readonly machines: MachinesRepository,
    private readonly parts: MachinePartsRepository,
    private readonly transitions: MachineStateTransitionPolicy,
    private readonly rules: MachineLogRules,
    private readonly downtime: DowntimeCalculator,
    private readonly transactions: TransactionRunner,
    private readonly audit: AuditService,
    private readonly events: DomainEventBus,
    private readonly statusSync: MachineStatusSynchronizer,
    private readonly clock: Clock,
  ) {}

  async create(dto: CreateMachineLogDto, actor: AuthenticatedUser, meta: RequestMeta): Promise<MachineLog> {
    const now = this.clock.now();

    const { logId, changes } = await this.transactions.run(async (manager) => {
      const machine = await this.machines.findByIdForUpdate(dto.machineId, manager);
      if (!machine) throw AppError.notFound('Machine not found', ErrorCode.MACHINE_NOT_FOUND);
      if (!machine.isActive) {
        throw AppError.unprocessable(
          'Logs cannot be recorded for a deactivated machine',
          ErrorCode.MACHINE_INACTIVE,
        );
      }
      const subject: LogSubject = {
        machine,
        part:
          dto.machinePartId === undefined
            ? null
            : await this.requireLoggablePart(machine, dto.machinePartId, manager),
      };

      const entryStatus = this.subjectState(subject);
      if (dto.entryStatus !== undefined) this.assertSubjectState(subject, dto.entryStatus);
      this.transitions.assertAllowed(entryStatus, dto.resultingState);

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

      const operationalImpact = subject.part
        ? this.resolveImpact(dto.resultingState, dto.operationalImpact, subject.part.isCritical)
        : null;

      const log = await this.logs.save(
        this.logs.create({
          machineId: machine.id,
          scope: subject.part ? LogScope.PART : LogScope.MACHINE,
          machinePartId: subject.part?.id ?? null,
          userId: actor.id,
          faultDescription: dto.faultDescription,
          causeDescription: dto.causeDescription ?? null,
          entryStatus,
          remedyAction: dto.remedyAction ?? null,
          resultingState: dto.resultingState,
          operationalImpact,
          // The machine status as it is right now, already synced with its parts.
          machineStatusBefore: machine.status,
          machineStatusAfter: machine.status,
          operationalStatusBefore: machine.operationalStatus,
          operationalStatusAfter: machine.operationalStatus,
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

      const partChange = await this.applySubjectState(subject, log, actor, meta, manager);
      const statusChange = await this.syncMachineStatus(subject, log, actor, meta, manager);
      await this.recordStatusAfter(log, machine, manager);
      return {
        logId: log.id,
        changes: {
          // Every part log is announced, even when the part's condition is unchanged.
          partChange:
            subject.part && !partChange
              ? { part: subject.part, previousStatus: entryStatus, logId: log.id, logStatus: log.logStatus }
              : partChange,
          statusChange,
        },
      };
    });

    this.publish(changes, actor, now);
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

    const changes = await this.transactions.run(async (manager): Promise<StatusChanges> => {
      // Lock order: machine, then part, then log (same as create/delete) to avoid deadlocks.
      const subject = await this.lockSubject(existing, manager);
      const log = await this.logs.findByIdForUpdate(id, manager);
      if (!log) throw AppError.notFound('Machine log not found', ErrorCode.MACHINE_LOG_NOT_FOUND);
      const { machine, part } = subject;
      if (log.version !== dto.version) {
        throw AppError.conflict(
          'This log was modified by someone else. Reload it and try again.',
          ErrorCode.STALE_VERSION,
        );
      }
      if (dto.operationalImpact !== undefined && !part) {
        throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Request validation failed', [
          { field: 'operationalImpact', message: 'is only allowed on part logs' },
        ]);
      }

      const isLatest = await this.isLatestForSubject(subject, log, manager);
      const before = toMachineLogAuditSnapshot(log);
      const previousResultingState = log.resultingState;
      const previousImpact = log.operationalImpact;

      if (dto.resultingState !== undefined && dto.resultingState !== log.resultingState) {
        if (!isLatest) {
          throw AppError.conflict(
            part
              ? "Only the part's most recent log can change its resulting state"
              : "Only the machine's most recent log can change its resulting state",
            ErrorCode.RESULTING_STATE_IMMUTABLE,
          );
        }
        if (!machine.isActive || machine.deletedAt) {
          throw AppError.unprocessable(
            'The state of a deactivated machine cannot be changed',
            ErrorCode.MACHINE_INACTIVE,
          );
        }
        if (part && !part.isActive) {
          throw AppError.unprocessable(
            'The condition of a deactivated part cannot be changed',
            ErrorCode.MACHINE_PART_INACTIVE,
          );
        }
        this.assertSubjectState(subject, log.resultingState);
        this.transitions.assertAllowed(log.entryStatus, dto.resultingState);
        log.resultingState = dto.resultingState;
      }

      if (dto.faultDescription !== undefined) log.faultDescription = dto.faultDescription;
      if (dto.causeDescription !== undefined) log.causeDescription = dto.causeDescription;
      if (dto.remedyAction !== undefined) log.remedyAction = dto.remedyAction;
      if (dto.nextMaintenancePlan !== undefined) log.nextMaintenancePlan = dto.nextMaintenancePlan;
      if (dto.startedAt !== undefined) log.startedAt = dto.startedAt;
      this.applyLogStatus(log, dto, now);
      if (part) {
        log.operationalImpact = this.resolveImpact(
          log.resultingState,
          dto.operationalImpact ?? log.operationalImpact ?? undefined,
          part.isCritical,
        );
      }

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
      if (Object.keys(newValues).length === 0) return NO_CHANGES;

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

      // Only the subject's most recent log defines its current state.
      const subjectChanged =
        log.resultingState !== previousResultingState || log.operationalImpact !== previousImpact;
      if (!isLatest || !subjectChanged) return NO_CHANGES;

      const partChange = await this.applySubjectState(subject, log, actor, meta, manager);
      const statusChange = await this.syncMachineStatus(subject, log, actor, meta, manager);
      await this.recordStatusAfter(log, machine, manager);
      return { partChange, statusChange };
    });

    this.publish(changes, actor, now);
    return this.getById(id);
  }

  /**
   * Soft-deletes a log (ADMIN only). Deleting the most recent log of a subject
   * (the machine system or a part) reverts it to that log's entry status — the
   * state it was in immediately before the event — and re-derives the machine
   * status.
   */
  async remove(id: number, actor: AuthenticatedUser, meta: RequestMeta): Promise<void> {
    const existing = await this.getById(id);
    const now = this.clock.now();

    const changes = await this.transactions.run(async (manager): Promise<StatusChanges> => {
      const subject = await this.lockSubject(existing, manager);
      const log = await this.logs.findByIdForUpdate(id, manager);
      if (!log) throw AppError.notFound('Machine log not found', ErrorCode.MACHINE_LOG_NOT_FOUND);

      const isLatest = await this.isLatestForSubject(subject, log, manager);
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
      if (!isLatest) return NO_CHANGES;

      const revert = await this.revertedState(subject, log, manager);
      const partChange = await this.applySubjectState(subject, revert, actor, meta, manager);
      const statusChange = await this.syncMachineStatus(subject, log, actor, meta, manager);
      return { partChange, statusChange };
    });

    this.publish(changes, actor, now);
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

  /** The machine's whole history: whole-machine and part events together. */
  async history(machineId: number, query: MachineHistoryQuery): Promise<Page<MachineLog>> {
    const machine = await this.machines.findById(machineId);
    if (!machine) throw AppError.notFound('Machine not found', ErrorCode.MACHINE_NOT_FOUND);
    return this.logs.findPage(
      { ...this.filtersFrom(query), machineId },
      { sortBy: query.sortBy, sortOrder: query.sortOrder },
      { page: query.page, limit: query.limit },
    );
  }

  /** History of one part, newest first by default. */
  async partHistory(partId: number, query: MachineHistoryQuery): Promise<Page<MachineLog>> {
    const part = await this.parts.findById(partId);
    if (!part) throw AppError.notFound('Machine part not found', ErrorCode.MACHINE_PART_NOT_FOUND);
    return this.logs.findPage(
      { ...this.filtersFrom(query), machineId: part.machineId, machinePartId: part.id },
      { sortBy: query.sortBy, sortOrder: query.sortOrder },
      { page: query.page, limit: query.limit },
    );
  }

  describeRules() {
    return this.transitions.describe();
  }

  // ------------------------------------------------------------------- internals

  private async requireLoggablePart(
    machine: Machine,
    partId: number,
    manager: EntityManager,
  ): Promise<MachinePart> {
    const part = await this.parts.findByIdForUpdate(partId, manager);
    if (part?.machineId !== machine.id) {
      throw AppError.notFound('Machine part not found', ErrorCode.MACHINE_PART_NOT_FOUND);
    }
    if (!part.isActive) {
      throw AppError.unprocessable(
        'Logs cannot be recorded for a deactivated part',
        ErrorCode.MACHINE_PART_INACTIVE,
      );
    }
    return part;
  }

  /** Locks the machine and, for part logs, the part (machine first, then part). */
  private async lockSubject(log: MachineLog, manager: EntityManager): Promise<LogSubject> {
    const machine = await this.machines.findByIdForUpdateIncludingDeleted(log.machineId, manager);
    const part =
      log.machinePartId === null ? null : await this.parts.findByIdForUpdate(log.machinePartId, manager);
    if (!machine || (log.machinePartId !== null && !part)) {
      throw AppError.notFound('Machine log not found', ErrorCode.MACHINE_LOG_NOT_FOUND);
    }
    return { machine, part };
  }

  private subjectState(subject: LogSubject): MachineState {
    return subject.part ? subject.part.status : subject.machine.systemStatus;
  }

  private async isLatestForSubject(subject: LogSubject, log: MachineLog, manager: EntityManager) {
    const latestId = subject.part
      ? await this.logs.findLatestIdForPart(subject.part.id, manager)
      : await this.logs.findLatestIdForMachineSystem(subject.machine.id, manager);
    return latestId === log.id;
  }

  /** Optimistic expected-state check performed while holding the machine (and part) lock. */
  private assertSubjectState(subject: LogSubject, expected: MachineState): void {
    const current = this.subjectState(subject);
    if (current === expected) return;
    if (subject.part) {
      throw new AppError(
        409,
        ErrorCode.MACHINE_PART_STATE_CONFLICT,
        `Part status has changed to ${current} (expected ${expected}). Reload the part and try again.`,
        [{ field: 'entryStatus', message: `current part status is ${current}` }],
      );
    }
    throw new AppError(
      409,
      ErrorCode.MACHINE_STATE_CONFLICT,
      `Machine status has changed to ${current} (expected ${expected}). Reload the machine and try again.`,
      [{ field: 'entryStatus', message: `current machine system status is ${current}` }],
    );
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

  /**
   * The state a subject returns to when its latest log is deleted: the log's
   * entry status, with the impact of the part's previous log (if any).
   */
  private async revertedState(
    subject: LogSubject,
    log: MachineLog,
    manager: EntityManager,
  ): Promise<Pick<MachineLog, 'id' | 'logStatus' | 'resultingState' | 'operationalImpact'>> {
    if (!subject.part) {
      return {
        id: log.id,
        logStatus: log.logStatus,
        resultingState: log.entryStatus,
        operationalImpact: null,
      };
    }
    const previousId = await this.logs.findLatestIdForPart(subject.part.id, manager);
    const previous = previousId === null ? null : await this.logs.findByIdForUpdate(previousId, manager);
    return {
      id: log.id,
      logStatus: log.logStatus,
      resultingState: log.entryStatus,
      operationalImpact: this.resolveImpact(
        log.entryStatus,
        previous?.operationalImpact ?? undefined,
        subject.part.isCritical,
      ),
    };
  }

  /** Writes the log's resulting state onto its subject: the machine system or the part. */
  private async applySubjectState(
    subject: LogSubject,
    log: Pick<MachineLog, 'id' | 'logStatus' | 'resultingState' | 'operationalImpact'>,
    actor: AuthenticatedUser,
    meta: RequestMeta,
    manager: EntityManager,
  ): Promise<PartChange | null> {
    const { machine, part } = subject;
    if (!part) {
      const previous = machine.systemStatus;
      if (previous === log.resultingState) return null;
      await this.machines.updateSystemStatus(machine.id, log.resultingState, manager);
      machine.systemStatus = log.resultingState;
      await this.audit.record(
        {
          action: AuditAction.MACHINE_SYSTEM_STATUS_CHANGED,
          entity: AuditEntity.MACHINE,
          entityId: machine.id,
          actorId: actor.id,
          oldValues: { systemStatus: previous },
          newValues: { systemStatus: log.resultingState, logId: log.id },
          meta,
        },
        manager,
      );
      return null;
    }

    const condition = {
      status: log.resultingState,
      operationalImpact: log.operationalImpact ?? OperationalImpact.NON_BLOCKING,
    };
    const previousStatus = part.status;
    const previousImpact = part.operationalImpact;
    if (previousStatus === condition.status && previousImpact === condition.operationalImpact) return null;

    await this.parts.updateCondition(part.id, condition, manager);
    part.status = condition.status;
    part.operationalImpact = condition.operationalImpact;
    await this.audit.record(
      {
        action: AuditAction.MACHINE_PART_STATUS_CHANGED,
        entity: AuditEntity.MACHINE_PART,
        entityId: part.id,
        actorId: actor.id,
        oldValues: { status: previousStatus, operationalImpact: previousImpact },
        newValues: { ...condition, logId: log.id },
        meta,
      },
      manager,
    );
    return { part, previousStatus, logId: log.id, logStatus: log.logStatus };
  }

  /** Re-derives the machine status from its system status and all its parts. */
  private syncMachineStatus(
    subject: LogSubject,
    log: MachineLog,
    actor: AuthenticatedUser,
    meta: RequestMeta,
    manager: EntityManager,
  ): Promise<MachineStatusChange | null> {
    return this.statusSync.synchronize({
      machine: subject.machine,
      trigger: {
        type: 'MACHINE_LOG',
        logId: log.id,
        scope: log.scope,
        ...(subject.part ? { partId: subject.part.id } : {}),
      },
      actor,
      meta,
      manager,
    });
  }

  /** Records the machine's synced status after the event on the log itself. */
  private async recordStatusAfter(log: MachineLog, machine: Machine, manager: EntityManager): Promise<void> {
    if (
      log.machineStatusAfter === machine.status &&
      log.operationalStatusAfter === machine.operationalStatus
    ) {
      return;
    }
    log.machineStatusAfter = machine.status;
    log.operationalStatusAfter = machine.operationalStatus;
    await this.logs.save(log, manager);
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

  private publish(changes: StatusChanges, actor: AuthenticatedUser, at: Date): void {
    const { partChange } = changes;
    if (partChange) {
      this.events.publish(MACHINE_PART_UPDATED, {
        machineId: partChange.part.machineId,
        partId: partChange.part.id,
        partCode: partChange.part.partCode,
        partName: partChange.part.name,
        previousStatus: partChange.previousStatus,
        newStatus: partChange.part.status,
        operationalImpact: partChange.part.operationalImpact,
        isCritical: partChange.part.isCritical,
        logId: partChange.logId,
        logStatus: partChange.logStatus,
        updatedBy: { id: actor.id, name: actor.name },
        timestamp: at.toISOString(),
      });
    }
    this.statusSync.publish(changes.statusChange, actor, at);
  }

  private filtersFrom(query: LogFilterQuery): MachineLogFilters {
    return {
      ...(query.machineId !== undefined ? { machineId: query.machineId } : {}),
      ...(query.scope ? { scope: query.scope } : {}),
      ...(query.machinePartId !== undefined ? { machinePartId: query.machinePartId } : {}),
      ...(query.operationalImpact ? { operationalImpact: query.operationalImpact } : {}),
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
