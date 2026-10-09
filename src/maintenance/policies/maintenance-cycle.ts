import { MaintenanceReminderKind, MaintenanceScheduleState } from '../../common/enums/maintenance.enums';

const MS_PER_DAY = 86_400_000;
const DEFAULT_REMINDER_DAYS = 3;

/** Start of the UTC calendar day containing `date`. */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/** Whole UTC calendar days from `from` to `to` (negative when `to` is in the past). */
export function calendarDaysBetween(from: Date, to: Date): number {
  return Math.round((startOfUtcDay(to).getTime() - startOfUtcDay(from).getTime()) / MS_PER_DAY);
}

/**
 * The next due date is always the actual completion time plus the interval —
 * never the scheduled date. Maintenance completed late therefore shifts the
 * whole cycle (completed 18 Oct with a 20-day interval → next 7 Nov).
 */
export function nextMaintenanceAfter(completedAt: Date, intervalDays: number): Date {
  return addDays(completedAt, intervalDays);
}

/**
 * The first due date of a schedule: from the last known maintenance when the
 * machine has history (25 Sep + 20 days → 15 Oct, regardless of today), from
 * an explicit start date, or one interval from now for a brand-new machine.
 */
export function initialNextMaintenance(input: {
  intervalDays: number;
  lastMaintenanceAt?: Date | null;
  nextMaintenanceAt?: Date | null;
  now: Date;
}): Date {
  if (input.nextMaintenanceAt) return input.nextMaintenanceAt;
  if (input.lastMaintenanceAt) return nextMaintenanceAfter(input.lastMaintenanceAt, input.intervalDays);
  return addDays(input.now, input.intervalDays);
}

/** Reminders start 3 days ahead, but always before the due day (so a daily task gets 0). */
export function defaultReminderDays(intervalDays: number): number {
  return Math.max(0, Math.min(DEFAULT_REMINDER_DAYS, intervalDays - 1));
}

export interface ScheduleStatus {
  readonly state: MaintenanceScheduleState;
  /** Whole days until the due date; 0 on the due day, negative when overdue. */
  readonly daysUntilDue: number;
  /** True while within `reminderDaysBefore` of the due date (or past it). */
  readonly withinReminderWindow: boolean;
  /** The reminder that applies now, or null when the due date is still far away. */
  readonly reminderKind: MaintenanceReminderKind | null;
}

/**
 * Derives UPCOMING / DUE / OVERDUE from the due date. This is a maintenance
 * state only: it never changes the machine's operational status.
 */
export function resolveScheduleStatus(
  schedule: { nextMaintenanceAt: Date; reminderDaysBefore: number },
  now: Date,
): ScheduleStatus {
  const daysUntilDue = calendarDaysBetween(now, schedule.nextMaintenanceAt);
  if (daysUntilDue < 0) {
    return {
      state: MaintenanceScheduleState.OVERDUE,
      daysUntilDue,
      withinReminderWindow: true,
      reminderKind: MaintenanceReminderKind.OVERDUE,
    };
  }
  if (daysUntilDue === 0) {
    return {
      state: MaintenanceScheduleState.DUE,
      daysUntilDue,
      withinReminderWindow: true,
      reminderKind: MaintenanceReminderKind.DUE,
    };
  }
  const withinReminderWindow = daysUntilDue <= schedule.reminderDaysBefore;
  return {
    state: MaintenanceScheduleState.UPCOMING,
    daysUntilDue,
    withinReminderWindow,
    reminderKind: withinReminderWindow ? MaintenanceReminderKind.UPCOMING : null,
  };
}

/** The UTC calendar day of a due date; identifies a maintenance cycle for reminders. */
export function cycleKey(nextMaintenanceAt: Date): string {
  return startOfUtcDay(nextMaintenanceAt).toISOString().slice(0, 10);
}
