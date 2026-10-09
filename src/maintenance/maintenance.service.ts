import { type EntityManager } from 'typeorm';
import { AuditAction, AuditEntity } from '../audit/audit.constants';
import { type AuditService } from '../audit/audit.service';
import { diffValues } from '../audit/audit-sanitizer';
import { type AuthenticatedUser } from '../auth/auth.types';
import { type TransactionRunner } from '../common/database/transaction-runner';
import { LogStatus } from '../common/enums/log-status.enum';
import { MachineState } from '../common/enums/machine-state.enum';
import { MaintenanceEventStatus } from '../common/enums/maintenance.enums';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { isUniqueViolation } from '../common/errors/database-errors';
import { type DomainEventBus } from '../common/events/domain-event-bus';
import { MAINTENANCE_COMPLETED } from '../common/events/domain-events';
import { type RequestMeta } from '../common/http/request-meta';
import { type AppLogger } from '../common/logger/logger';
import { type Page } from '../common/pagination/pagination';
import { type Clock } from '../common/utils/clock';
import { endOfUtcDayExclusive, startOfUtcDay } from '../common/utils/date-range';
import { type MachineLogsService } from '../machine-logs/machine-logs.service';
import { type MachinePart } from '../machine-parts/machine-part.entity';
import { type MachinePartsRepository } from '../machine-parts/machine-parts.repository';
import { type Machine } from '../machines/machine.entity';
import { type MachinesRepository } from '../machines/machines.repository';
import { type MaintenanceEvent } from './maintenance-event.entity';
import { type MaintenanceSchedule } from './maintenance-schedule.entity';
import {
  type CancelMaintenanceEventDto,
  type CompleteMaintenanceEventDto,
  type CreateMaintenanceEventDto,
  type CreateMaintenanceScheduleDto,
  type ListMaintenanceEventsQuery,
  type ListMaintenanceSchedulesQuery,
  type MaintenanceDashboardQuery,
  type StartMaintenanceEventDto,
  type UpdateMaintenanceEventDto,
  type UpdateMaintenanceScheduleDto,
} from './maintenance.dto';
import { toMaintenanceEventAuditSnapshot, toMaintenanceScheduleAuditSnapshot } from './maintenance.mapper';
import { type MaintenanceRepository } from './maintenance.repository';
import {
  defaultReminderDays,
  initialNextMaintenance,
  nextMaintenanceAfter,
} from './policies/maintenance-cycle';

const OPEN_EVENT_STATUSES: readonly MaintenanceEventStatus[] = [
  MaintenanceEventStatus.SCHEDULED,
  MaintenanceEventStatus.IN_PROGRESS,
];

const MAINTENANCE_FAULT_DESCRIPTION = 'Scheduled preventive maintenance';
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const SCHEDULE_EXISTS_MESSAGE = 'A maintenance schedule with this task already exists';
const SCHEDULE_UNIQUE_CONSTRAINTS = [
  'UQ_maintenance_schedules_part_task',
  'UQ_maintenance_schedules_machine_task',
] as const;

/**
 * Recurring preventive maintenance: schedules, their executions and the cycle
 * arithmetic. A machine has many schedules, each either for one of its parts
 * or for the machine as a whole, with its own interval.
 *
 * Completing an event and rolling the schedule forward happen in one
 * transaction, so a completed maintenance can never leave a stale due date.
 * Machine status is *not* changed directly here: starting and finishing
 * maintenance goes through MachineLogsService, the existing machine workflow
 * (a part log for part maintenance, a machine log otherwise), which in turn
 * recalculates the derived operational status. Those calls open
 * their own transactions and therefore run before/after ours, never nested
 * (nesting would deadlock on the machine row lock).
 */
export class MaintenanceService {
  constructor(
    private readonly repository: MaintenanceRepository,
    private readonly machines: MachinesRepository,
    private readonly parts: MachinePartsRepository,
    private readonly machineLogs: MachineLogsService,
    private readonly transactions: TransactionRunner,
    private readonly audit: AuditService,
    private readonly events: DomainEventBus,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
  ) {}

  // ------------------------------------------------------------------ schedules

  async createSchedule(
    machineId: number,
    dto: CreateMaintenanceScheduleDto,
    actor: AuthenticatedUser,
    meta: RequestMeta,
  ): Promise<MaintenanceSchedule> {
    const now = this.clock.now();
    const machine = await this.requireMachine(machineId);
    if (!machine.isActive) {
      throw AppError.unprocessable(
        'Maintenance cannot be scheduled for a deactivated machine',
        ErrorCode.MACHINE_INACTIVE,
      );
    }
    const part =
      dto.machinePartId === undefined ? null : await this.requireActivePart(machineId, dto.machinePartId);
    const taskName = dto.taskName ?? part?.name;
    if (taskName === undefined) {
      throw AppError.unprocessable(
        'taskName is required for machine-wide tasks',
        ErrorCode.VALIDATION_ERROR,
        [{ field: 'taskName', message: 'is required for machine-wide tasks' }],
      );
    }
    if (await this.repository.findScheduleByTask({ machineId, machinePartId: part?.id ?? null, taskName })) {
      throw AppError.conflict(SCHEDULE_EXISTS_MESSAGE, ErrorCode.MAINTENANCE_SCHEDULE_EXISTS);
    }

    const nextMaintenanceAt = initialNextMaintenance({
      intervalDays: dto.intervalDays,
      lastMaintenanceAt: dto.lastMaintenanceAt ?? null,
      nextMaintenanceAt: dto.nextMaintenanceAt ?? null,
      now,
    });

    const scheduleId = await this.withScheduleConflictMapping(() =>
      this.transactions.run(async (manager) => {
        const schedule = await this.repository.saveSchedule(
          this.repository.createSchedule({
            machineId,
            machinePartId: part?.id ?? null,
            taskName,
            description: dto.description ?? null,
            intervalDays: dto.intervalDays,
            reminderDaysBefore: dto.reminderDaysBefore ?? defaultReminderDays(dto.intervalDays),
            lastMaintenanceAt: dto.lastMaintenanceAt ?? null,
            nextMaintenanceAt,
            isActive: true,
          }),
          manager,
        );
        await this.audit.record(
          {
            action: AuditAction.MAINTENANCE_SCHEDULE_CREATED,
            entity: AuditEntity.MAINTENANCE_SCHEDULE,
            entityId: schedule.id,
            actorId: actor.id,
            newValues: toMaintenanceScheduleAuditSnapshot(schedule),
            meta,
          },
          manager,
        );
        return schedule.id;
      }),
    );
    return this.getSchedule(scheduleId);
  }

  async getSchedule(id: number): Promise<MaintenanceSchedule> {
    const schedule = await this.repository.findScheduleById(id);
    if (!schedule) {
      throw AppError.notFound('Maintenance schedule not found', ErrorCode.MAINTENANCE_SCHEDULE_NOT_FOUND);
    }
    return schedule;
  }

  /** Every schedule of a machine: machine-wide tasks and part tasks. */
  async listSchedules(
    machineId: number,
    query: ListMaintenanceSchedulesQuery,
  ): Promise<MaintenanceSchedule[]> {
    await this.requireMachine(machineId);
    return this.repository.findSchedulesByMachine(machineId, {
      ...(query.machinePartId !== undefined ? { machinePartId: query.machinePartId } : {}),
      ...(query.scope ? { scope: query.scope } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    });
  }

  async updateSchedule(
    id: number,
    dto: UpdateMaintenanceScheduleDto,
    actor: AuthenticatedUser,
    meta: RequestMeta,
  ): Promise<MaintenanceSchedule> {
    await this.withScheduleConflictMapping(() =>
      this.transactions.run(async (manager) => {
        const schedule = await this.repository.findScheduleByIdForUpdate(id, manager);
        if (!schedule) {
          throw AppError.notFound('Maintenance schedule not found', ErrorCode.MAINTENANCE_SCHEDULE_NOT_FOUND);
        }
        const before = toMaintenanceScheduleAuditSnapshot(schedule);

        if (dto.taskName !== undefined) schedule.taskName = dto.taskName;
        if (dto.description !== undefined) schedule.description = dto.description;
        if (dto.intervalDays !== undefined) schedule.intervalDays = dto.intervalDays;
        if (dto.reminderDaysBefore !== undefined) schedule.reminderDaysBefore = dto.reminderDaysBefore;
        if (dto.lastMaintenanceAt !== undefined) schedule.lastMaintenanceAt = dto.lastMaintenanceAt;
        if (dto.isActive !== undefined) schedule.isActive = dto.isActive;

        // An explicit due date wins; otherwise recompute from the (possibly new) history.
        if (dto.nextMaintenanceAt !== undefined) {
          schedule.nextMaintenanceAt = dto.nextMaintenanceAt;
        } else if (
          (dto.intervalDays !== undefined || dto.lastMaintenanceAt !== undefined) &&
          schedule.lastMaintenanceAt
        ) {
          schedule.nextMaintenanceAt = nextMaintenanceAfter(
            schedule.lastMaintenanceAt,
            schedule.intervalDays,
          );
        }

        if (schedule.reminderDaysBefore > schedule.intervalDays) {
          throw AppError.unprocessable(
            'reminderDaysBefore cannot exceed intervalDays',
            ErrorCode.VALIDATION_ERROR,
            [{ field: 'reminderDaysBefore', message: `must be at most ${schedule.intervalDays}` }],
          );
        }

        const { oldValues, newValues } = diffValues(before, toMaintenanceScheduleAuditSnapshot(schedule));
        if (Object.keys(newValues).length === 0) return;

        await this.repository.saveSchedule(schedule, manager);
        await this.audit.record(
          {
            action: AuditAction.MAINTENANCE_SCHEDULE_UPDATED,
            entity: AuditEntity.MAINTENANCE_SCHEDULE,
            entityId: schedule.id,
            actorId: actor.id,
            oldValues,
            newValues,
            meta,
          },
          manager,
        );
      }),
    );
    return this.getSchedule(id);
  }

  /** Dashboard listings: upcoming (inside the reminder window), due today, overdue. */
  schedulesByState(
    state: 'upcoming' | 'due' | 'overdue',
    query: MaintenanceDashboardQuery,
  ): Promise<Page<MaintenanceSchedule>> {
    return this.repository.findSchedulesPage(
      {
        state,
        isActive: true,
        now: this.clock.now(),
        ...(query.machineId !== undefined ? { machineId: query.machineId } : {}),
        ...(query.machinePartId !== undefined ? { machinePartId: query.machinePartId } : {}),
        ...(query.scope ? { scope: query.scope } : {}),
      },
      { page: query.page, limit: query.limit },
    );
  }

  // --------------------------------------------------------------------- events

  /**
   * Planned maintenance is created from its schedule (machine and part come
   * from it); one-off maintenance names the machine and, optionally, the part.
   */
  async createEvent(
    dto: CreateMaintenanceEventDto,
    actor: AuthenticatedUser,
    meta: RequestMeta,
  ): Promise<MaintenanceEvent> {
    const now = this.clock.now();
    const schedule =
      dto.maintenanceScheduleId === undefined ? null : await this.getSchedule(dto.maintenanceScheduleId);
    const machineId = schedule?.machineId ?? dto.machineId;
    if (machineId === undefined) {
      throw AppError.unprocessable(
        'machineId is required for one-off maintenance',
        ErrorCode.VALIDATION_ERROR,
        [{ field: 'machineId', message: 'is required when maintenanceScheduleId is omitted' }],
      );
    }
    const machine = await this.requireMachine(machineId);
    if (!machine.isActive) {
      throw AppError.unprocessable(
        'Maintenance cannot be recorded for a deactivated machine',
        ErrorCode.MACHINE_INACTIVE,
      );
    }
    let machinePartId = schedule ? schedule.machinePartId : (dto.machinePartId ?? null);
    if (!schedule && machinePartId !== null) {
      machinePartId = (await this.requireActivePart(machineId, machinePartId)).id;
    }

    const eventId = await this.transactions.run(async (manager) => {
      if (schedule) {
        // Serialise event creation per schedule so only one stays open.
        await this.repository.findScheduleByIdForUpdate(schedule.id, manager);
        const open = await this.repository.findOpenEventForSchedule(schedule.id, manager);
        if (open) {
          throw AppError.conflict(
            `Maintenance event ${open.id} for this task is still ${open.status}`,
            ErrorCode.MAINTENANCE_EVENT_ALREADY_OPEN,
          );
        }
      }
      const event = await this.repository.saveEvent(
        this.repository.createEvent({
          maintenanceScheduleId: schedule?.id ?? null,
          machineId,
          machinePartId,
          scheduledFor: dto.scheduledFor ?? schedule?.nextMaintenanceAt ?? now,
          notes: dto.notes ?? null,
          status: MaintenanceEventStatus.SCHEDULED,
        }),
        manager,
      );
      await this.audit.record(
        {
          action: AuditAction.MAINTENANCE_EVENT_CREATED,
          entity: AuditEntity.MAINTENANCE_EVENT,
          entityId: event.id,
          actorId: actor.id,
          newValues: toMaintenanceEventAuditSnapshot(event),
          meta,
        },
        manager,
      );
      return event.id;
    });

    return this.getEvent(eventId);
  }

  async getEvent(id: number): Promise<MaintenanceEvent> {
    const event = await this.repository.findEventById(id);
    if (!event) {
      throw AppError.notFound('Maintenance event not found', ErrorCode.MAINTENANCE_EVENT_NOT_FOUND);
    }
    return event;
  }

  listEvents(query: ListMaintenanceEventsQuery): Promise<Page<MaintenanceEvent>> {
    return this.repository.findEventsPage(
      {
        ...(query.machineId !== undefined ? { machineId: query.machineId } : {}),
        ...(query.machinePartId !== undefined ? { machinePartId: query.machinePartId } : {}),
        ...(query.maintenanceScheduleId !== undefined
          ? { maintenanceScheduleId: query.maintenanceScheduleId }
          : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.performedById !== undefined ? { performedById: query.performedById } : {}),
        ...(query.from ? { from: startOfUtcDay(query.from) } : {}),
        ...(query.to ? { to: endOfUtcDayExclusive(query.to) } : {}),
      },
      { sortBy: query.sortBy, sortOrder: query.sortOrder },
      { page: query.page, limit: query.limit },
    );
  }

  async updateEvent(
    id: number,
    dto: UpdateMaintenanceEventDto,
    actor: AuthenticatedUser,
    meta: RequestMeta,
  ): Promise<MaintenanceEvent> {
    await this.transactions.run(async (manager) => {
      const event = await this.requireEventForUpdate(id, manager);
      this.assertEventStatus(event, OPEN_EVENT_STATUSES);
      const before = toMaintenanceEventAuditSnapshot(event);

      if (dto.scheduledFor !== undefined) event.scheduledFor = dto.scheduledFor;
      if (dto.notes !== undefined) event.notes = dto.notes;

      const { oldValues, newValues } = diffValues(before, toMaintenanceEventAuditSnapshot(event));
      await this.repository.saveEvent(event, manager);
      if (Object.keys(newValues).length > 0 || dto.notes !== undefined) {
        await this.audit.record(
          {
            action: AuditAction.MAINTENANCE_EVENT_UPDATED,
            entity: AuditEntity.MAINTENANCE_EVENT,
            entityId: event.id,
            actorId: actor.id,
            oldValues,
            newValues,
            meta,
          },
          manager,
        );
      }
    });
    return this.getEvent(id);
  }

  /**
   * Starts maintenance. When requested, a log is opened first through the
   * machine workflow — a part log for part maintenance, a machine log
   * otherwise — moving the subject to UNDER_MAINTENANCE and recalculating the
   * machine's operational status; the event then records that log.
   */
  async startEvent(
    id: number,
    dto: StartMaintenanceEventDto,
    actor: AuthenticatedUser,
    meta: RequestMeta,
  ): Promise<MaintenanceEvent> {
    const now = this.clock.now();
    const event = await this.getEvent(id);
    this.assertEventStatus(event, [MaintenanceEventStatus.SCHEDULED]);

    let machineLogId: number | null = event.machineLogId;
    if (dto.putUnderMaintenance && machineLogId === null) {
      const machine = await this.requireMachine(event.machineId);
      const log = await this.machineLogs.create(
        {
          machineId: machine.id,
          ...(event.machinePartId !== null ? { machinePartId: event.machinePartId } : {}),
          faultDescription: this.maintenanceDescription(event),
          resultingState: MachineState.UNDER_MAINTENANCE,
          logStatus: LogStatus.OPEN,
          startedAt: now,
        },
        actor,
        meta,
      );
      machineLogId = log.id;
    }

    await this.transactions.run(async (manager) => {
      const locked = await this.requireEventForUpdate(id, manager);
      // Re-checked under the lock: another technician may have started it meanwhile.
      this.assertEventStatus(locked, [MaintenanceEventStatus.SCHEDULED]);
      const before = toMaintenanceEventAuditSnapshot(locked);

      locked.status = MaintenanceEventStatus.IN_PROGRESS;
      locked.startedAt = now;
      locked.performedById = actor.id;
      locked.machineLogId = machineLogId;
      if (dto.notes !== undefined) locked.notes = dto.notes;

      await this.repository.saveEvent(locked, manager);
      await this.audit.record(
        {
          action: AuditAction.MAINTENANCE_STARTED,
          entity: AuditEntity.MAINTENANCE_EVENT,
          entityId: locked.id,
          actorId: actor.id,
          oldValues: before,
          newValues: toMaintenanceEventAuditSnapshot(locked),
          meta,
        },
        manager,
      );
    });

    return this.getEvent(id);
  }

  /**
   * Completes maintenance and rolls the schedule forward from the *actual*
   * completion time (completed 18 Oct, interval 20 days → next 7 Nov), both in
   * one transaction. The log opened at start is then closed, returning the part
   * (or machine) to ACTIVE and re-deriving the machine's operational status.
   */
  async completeEvent(
    id: number,
    dto: CompleteMaintenanceEventDto,
    actor: AuthenticatedUser,
    meta: RequestMeta,
  ): Promise<MaintenanceEvent> {
    const now = this.clock.now();
    const completedAt = dto.completedAt ?? now;
    if (completedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
      throw AppError.unprocessable('completedAt cannot be in the future', ErrorCode.INVALID_LOG_TIMES, [
        { field: 'completedAt', message: 'cannot be in the future' },
      ]);
    }

    const { machineLogId, scheduleId, nextMaintenanceAt, machineName } = await this.transactions.run(
      async (manager) => {
        const event = await this.requireEventForUpdate(id, manager);
        this.assertEventStatus(event, OPEN_EVENT_STATUSES);
        if (event.startedAt && completedAt < event.startedAt) {
          throw AppError.unprocessable(
            'completedAt cannot be before the maintenance started',
            ErrorCode.INVALID_LOG_TIMES,
            [{ field: 'completedAt', message: 'cannot be before startedAt' }],
          );
        }
        const before = toMaintenanceEventAuditSnapshot(event);

        event.status = MaintenanceEventStatus.COMPLETED;
        event.completedAt = completedAt;
        event.startedAt = event.startedAt ?? completedAt;
        event.performedById = event.performedById ?? actor.id;
        if (dto.notes !== undefined) event.notes = dto.notes;
        await this.repository.saveEvent(event, manager);

        await this.audit.record(
          {
            action: AuditAction.MAINTENANCE_COMPLETED,
            entity: AuditEntity.MAINTENANCE_EVENT,
            entityId: event.id,
            actorId: actor.id,
            oldValues: before,
            newValues: toMaintenanceEventAuditSnapshot(event),
            meta,
          },
          manager,
        );

        let next: Date | null = null;
        if (event.maintenanceScheduleId !== null) {
          const schedule = await this.repository.findScheduleByIdForUpdate(
            event.maintenanceScheduleId,
            manager,
          );
          if (schedule) {
            const scheduleBefore = toMaintenanceScheduleAuditSnapshot(schedule);
            schedule.lastMaintenanceAt = completedAt;
            schedule.nextMaintenanceAt = nextMaintenanceAfter(completedAt, schedule.intervalDays);
            next = schedule.nextMaintenanceAt;
            await this.repository.saveSchedule(schedule, manager);
            const diff = diffValues(scheduleBefore, toMaintenanceScheduleAuditSnapshot(schedule));
            await this.audit.record(
              {
                action: AuditAction.MAINTENANCE_SCHEDULE_UPDATED,
                entity: AuditEntity.MAINTENANCE_SCHEDULE,
                entityId: schedule.id,
                actorId: actor.id,
                oldValues: diff.oldValues,
                newValues: { ...diff.newValues, completedEventId: event.id },
                meta,
              },
              manager,
            );
          }
        }

        const machine = await this.machines.findById(event.machineId, manager);
        return {
          machineLogId: event.machineLogId,
          scheduleId: event.maintenanceScheduleId,
          nextMaintenanceAt: next,
          machineName: machine?.name ?? '',
        };
      },
    );

    const event = await this.getEvent(id);
    if (dto.releaseOnComplete && machineLogId !== null) {
      await this.releaseLog(machineLogId, this.maintenanceDescription(event), actor, meta);
    }

    this.events.publish(MAINTENANCE_COMPLETED, {
      scheduleId,
      eventId: event.id,
      machineId: event.machineId,
      machineName,
      machinePartId: event.machinePartId,
      partName: event.machinePart?.name ?? null,
      taskName: event.maintenanceSchedule?.taskName ?? null,
      completedAt: completedAt.toISOString(),
      nextMaintenanceAt: nextMaintenanceAt?.toISOString() ?? null,
      performedBy: { id: actor.id, name: actor.name },
      timestamp: now.toISOString(),
    });
    return event;
  }

  async cancelEvent(
    id: number,
    dto: CancelMaintenanceEventDto,
    actor: AuthenticatedUser,
    meta: RequestMeta,
  ): Promise<MaintenanceEvent> {
    await this.transactions.run(async (manager) => {
      const event = await this.requireEventForUpdate(id, manager);
      this.assertEventStatus(event, OPEN_EVENT_STATUSES);
      const before = toMaintenanceEventAuditSnapshot(event);

      event.status = MaintenanceEventStatus.CANCELLED;
      if (dto.reason !== undefined) event.notes = dto.reason;
      await this.repository.saveEvent(event, manager);
      await this.audit.record(
        {
          action: AuditAction.MAINTENANCE_CANCELLED,
          entity: AuditEntity.MAINTENANCE_EVENT,
          entityId: event.id,
          actorId: actor.id,
          oldValues: before,
          newValues: toMaintenanceEventAuditSnapshot(event),
          meta,
        },
        manager,
      );
    });
    return this.getEvent(id);
  }

  // ------------------------------------------------------------------ internals

  /**
   * Closes the log opened when maintenance started. Runs after the completion
   * transaction (it takes the machine lock itself); a failure leaves the event
   * completed with an open log, which an operator can close manually.
   */
  private async releaseLog(
    machineLogId: number,
    remedyAction: string,
    actor: AuthenticatedUser,
    meta: RequestMeta,
  ): Promise<void> {
    try {
      const log = await this.machineLogs.getById(machineLogId);
      if (log.logStatus === LogStatus.CLOSED) return;
      await this.machineLogs.update(
        machineLogId,
        {
          version: log.version,
          resultingState: MachineState.ACTIVE,
          logStatus: LogStatus.CLOSED,
          remedyAction,
        },
        actor,
        meta,
      );
    } catch (error: unknown) {
      this.logger.warn(
        { err: error, machineLogId },
        'Maintenance completed but the machine log could not be closed automatically',
      );
    }
  }

  /** "Scheduled preventive maintenance: Cutting head" for planned work. */
  private maintenanceDescription(event: MaintenanceEvent): string {
    const task = event.maintenanceSchedule?.taskName;
    return task ? `${MAINTENANCE_FAULT_DESCRIPTION}: ${task}` : MAINTENANCE_FAULT_DESCRIPTION;
  }

  private async requireActivePart(machineId: number, partId: number): Promise<MachinePart> {
    const part = await this.parts.findById(partId);
    if (part?.machineId !== machineId) {
      throw AppError.notFound('Machine part not found', ErrorCode.MACHINE_PART_NOT_FOUND);
    }
    if (!part.isActive) {
      throw AppError.unprocessable(
        'Maintenance cannot be planned for a deactivated part',
        ErrorCode.MACHINE_PART_INACTIVE,
      );
    }
    return part;
  }

  private async requireMachine(machineId: number): Promise<Machine> {
    const machine = await this.machines.findById(machineId);
    if (!machine) throw AppError.notFound('Machine not found', ErrorCode.MACHINE_NOT_FOUND);
    return machine;
  }

  private async requireEventForUpdate(id: number, manager: EntityManager): Promise<MaintenanceEvent> {
    const event = await this.repository.findEventByIdForUpdate(id, manager);
    if (!event) {
      throw AppError.notFound('Maintenance event not found', ErrorCode.MAINTENANCE_EVENT_NOT_FOUND);
    }
    return event;
  }

  private assertEventStatus(event: MaintenanceEvent, allowed: readonly MaintenanceEventStatus[]): void {
    if (allowed.includes(event.status)) return;
    throw AppError.conflict(
      `Maintenance event is ${event.status}; expected ${allowed.join(' or ')}`,
      ErrorCode.MAINTENANCE_EVENT_STATE_CONFLICT,
    );
  }

  private async withScheduleConflictMapping<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error: unknown) {
      if (SCHEDULE_UNIQUE_CONSTRAINTS.some((constraint) => isUniqueViolation(error, constraint))) {
        throw AppError.conflict(SCHEDULE_EXISTS_MESSAGE, ErrorCode.MAINTENANCE_SCHEDULE_EXISTS);
      }
      throw error;
    }
  }
}
