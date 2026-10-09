/** Lifecycle of a single preventive-maintenance execution. PostgreSQL enum: `maintenance_event_status`. */
export enum MaintenanceEventStatus {
  SCHEDULED = 'SCHEDULED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  MISSED = 'MISSED',
  CANCELLED = 'CANCELLED',
}

/**
 * Derived state of a recurring schedule relative to today. Computed on read,
 * never stored, and independent of machine operational status.
 */
export enum MaintenanceScheduleState {
  UPCOMING = 'UPCOMING',
  DUE = 'DUE',
  OVERDUE = 'OVERDUE',
}

/** Reminder kinds; one notification per schedule, kind and maintenance cycle. PostgreSQL enum: `maintenance_reminder_kind`. */
export enum MaintenanceReminderKind {
  UPCOMING = 'UPCOMING',
  DUE = 'DUE',
  OVERDUE = 'OVERDUE',
}

export const MAINTENANCE_EVENT_STATUSES: readonly MaintenanceEventStatus[] =
  Object.values(MaintenanceEventStatus);
export const MAINTENANCE_SCHEDULE_STATES: readonly MaintenanceScheduleState[] =
  Object.values(MaintenanceScheduleState);
export const MAINTENANCE_REMINDER_KINDS: readonly MaintenanceReminderKind[] =
  Object.values(MaintenanceReminderKind);
