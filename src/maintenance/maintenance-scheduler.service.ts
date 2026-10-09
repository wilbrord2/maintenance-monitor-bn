import { AuditAction, AuditEntity } from '../audit/audit.constants';
import { type AuditService } from '../audit/audit.service';
import { MaintenanceEventStatus, MaintenanceScheduleState } from '../common/enums/maintenance.enums';
import { type DomainEventBus } from '../common/events/domain-event-bus';
import { MAINTENANCE_REMINDER } from '../common/events/domain-events';
import { SYSTEM_REQUEST_META } from '../common/http/request-meta';
import { type AppLogger } from '../common/logger/logger';
import { type Clock } from '../common/utils/clock';
import { type MailService } from '../notifications/mail/mail.service';
import { type UsersRepository } from '../users/users.repository';
import { type MaintenanceSchedule } from './maintenance-schedule.entity';
import { type MaintenanceRepository } from './maintenance.repository';
import { addDays, cycleKey, resolveScheduleStatus, startOfUtcDay } from './policies/maintenance-cycle';

/** Schedules further out than this are not inspected by the reminder job. */
const LOOKAHEAD_DAYS = 90;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export interface ReminderRunResult {
  readonly examined: number;
  readonly remindersSent: number;
  readonly eventsMissed: number;
}

/**
 * Sends preventive-maintenance reminders (UPCOMING, DUE, OVERDUE) to every
 * active user and marks events from past cycles as MISSED.
 *
 * Idempotent: a reminder is recorded per schedule, kind and maintenance cycle
 * under a unique constraint, so repeated runs — or several API replicas running
 * the job at once — never notify twice for the same cycle.
 */
export class MaintenanceSchedulerService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repository: MaintenanceRepository,
    private readonly users: UsersRepository,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly events: DomainEventBus,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
  ) {}

  async run(): Promise<ReminderRunResult> {
    const now = this.clock.now();
    const schedules = await this.repository.findActiveSchedulesDueBefore(addDays(now, LOOKAHEAD_DAYS));
    if (schedules.length === 0) return { examined: 0, remindersSent: 0, eventsMissed: 0 };

    const recipients = await this.users.findNotificationRecipients();
    let remindersSent = 0;
    let eventsMissed = 0;

    for (const schedule of schedules) {
      const status = resolveScheduleStatus(schedule, now);
      if (!status.reminderKind) continue;

      const recorded = await this.repository.recordNotification({
        maintenanceScheduleId: schedule.id,
        kind: status.reminderKind,
        cycleDueOn: cycleKey(schedule.nextMaintenanceAt),
        recipients: recipients.length,
      });
      if (!recorded) continue; // already notified for this cycle

      remindersSent += 1;
      this.events.publish(MAINTENANCE_REMINDER, {
        scheduleId: schedule.id,
        machineId: schedule.machineId,
        machineName: schedule.machine?.name ?? '',
        serialNumber: schedule.machine?.serialNumber ?? '',
        state: status.state,
        nextMaintenanceAt: schedule.nextMaintenanceAt.toISOString(),
        daysUntilDue: status.daysUntilDue,
        timestamp: now.toISOString(),
      });

      await this.audit.record({
        action: AuditAction.MAINTENANCE_REMINDER_SENT,
        entity: AuditEntity.MAINTENANCE_SCHEDULE,
        entityId: schedule.id,
        actorId: null,
        newValues: {
          kind: status.reminderKind,
          state: status.state,
          daysUntilDue: status.daysUntilDue,
          cycleDueOn: cycleKey(schedule.nextMaintenanceAt),
          recipients: recipients.length,
        },
        meta: SYSTEM_REQUEST_META,
      });

      await this.notify(schedule, status.state, status.daysUntilDue, recipients);

      if (status.state === MaintenanceScheduleState.OVERDUE) {
        eventsMissed += await this.markPastCycleEventsMissed(schedule, now);
      }
    }

    if (remindersSent > 0 || eventsMissed > 0) {
      this.logger.info(
        { examined: schedules.length, remindersSent, eventsMissed },
        'Maintenance reminders processed',
      );
    }
    return { examined: schedules.length, remindersSent, eventsMissed };
  }

  start(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (this.timer) return;
    const run = () => {
      this.run().catch((error: unknown) => {
        this.logger.error({ err: error }, 'Maintenance reminder job failed');
      });
    };
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
    run();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Events scheduled before the current cycle were never performed. */
  private async markPastCycleEventsMissed(schedule: MaintenanceSchedule, now: Date): Promise<number> {
    const cutoff = startOfUtcDay(schedule.nextMaintenanceAt);
    const missed = await this.repository.markEventsMissed(schedule.id, cutoff);
    for (const eventId of missed) {
      await this.audit.record({
        action: AuditAction.MAINTENANCE_MISSED,
        entity: AuditEntity.MAINTENANCE_EVENT,
        entityId: eventId,
        actorId: null,
        oldValues: { status: MaintenanceEventStatus.SCHEDULED },
        newValues: { status: MaintenanceEventStatus.MISSED, detectedAt: now.toISOString() },
        meta: SYSTEM_REQUEST_META,
      });
    }
    return missed.length;
  }

  /** Reminder emails are best effort: a mail failure must not stop the job. */
  private async notify(
    schedule: MaintenanceSchedule,
    state: MaintenanceScheduleState,
    daysUntilDue: number,
    recipients: readonly { email: string; fullName: string }[],
  ): Promise<void> {
    const dueOn = cycleKey(schedule.nextMaintenanceAt);
    for (const recipient of recipients) {
      try {
        await this.mail.sendMaintenanceReminder({
          to: recipient.email,
          fullName: recipient.fullName,
          machineName: schedule.machine?.name ?? `Machine ${schedule.machineId}`,
          serialNumber: schedule.machine?.serialNumber ?? '',
          state,
          dueOn,
          daysUntilDue,
          intervalDays: schedule.intervalDays,
        });
      } catch (error: unknown) {
        this.logger.warn({ err: error, scheduleId: schedule.id }, 'Maintenance reminder email failed');
      }
    }
  }
}
