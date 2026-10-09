import {
  type MaintenanceEventStatus,
  type MaintenanceScheduleState,
} from '../common/enums/maintenance.enums';
import { toMachineSummary, type MachineSummary } from '../machines/machine.mapper';
import { toUserSummary, type UserSummary } from '../users/user.mapper';
import { type MaintenanceEvent } from './maintenance-event.entity';
import { type MaintenanceSchedule } from './maintenance-schedule.entity';
import { resolveScheduleStatus } from './policies/maintenance-cycle';

export interface MaintenanceScheduleResponse {
  readonly id: number;
  readonly machineId: number;
  readonly machine: MachineSummary | null;
  readonly intervalDays: number;
  readonly reminderDaysBefore: number;
  readonly lastMaintenanceAt: string | null;
  readonly nextMaintenanceAt: string;
  readonly isActive: boolean;
  /** Derived, never stored: UPCOMING / DUE / OVERDUE. Independent of machine status. */
  readonly state: MaintenanceScheduleState;
  readonly daysUntilDue: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toMaintenanceScheduleResponse(
  schedule: MaintenanceSchedule,
  now: Date,
): MaintenanceScheduleResponse {
  const status = resolveScheduleStatus(schedule, now);
  return {
    id: schedule.id,
    machineId: schedule.machineId,
    machine: schedule.machine ? toMachineSummary(schedule.machine) : null,
    intervalDays: schedule.intervalDays,
    reminderDaysBefore: schedule.reminderDaysBefore,
    lastMaintenanceAt: schedule.lastMaintenanceAt?.toISOString() ?? null,
    nextMaintenanceAt: schedule.nextMaintenanceAt.toISOString(),
    isActive: schedule.isActive,
    state: status.state,
    daysUntilDue: status.daysUntilDue,
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
  };
}

export function toMaintenanceScheduleAuditSnapshot(schedule: MaintenanceSchedule): Record<string, unknown> {
  return {
    machineId: schedule.machineId,
    intervalDays: schedule.intervalDays,
    reminderDaysBefore: schedule.reminderDaysBefore,
    lastMaintenanceAt: schedule.lastMaintenanceAt,
    nextMaintenanceAt: schedule.nextMaintenanceAt,
    isActive: schedule.isActive,
  };
}

export interface MaintenanceEventResponse {
  readonly id: number;
  readonly maintenanceScheduleId: number | null;
  readonly machine: MachineSummary | null;
  readonly performedBy: UserSummary | null;
  readonly machineLogId: number | null;
  readonly scheduledFor: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly status: MaintenanceEventStatus;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toMaintenanceEventResponse(event: MaintenanceEvent): MaintenanceEventResponse {
  return {
    id: event.id,
    maintenanceScheduleId: event.maintenanceScheduleId,
    machine: event.machine ? toMachineSummary(event.machine) : null,
    performedBy: event.performedBy ? toUserSummary(event.performedBy) : null,
    machineLogId: event.machineLogId,
    scheduledFor: event.scheduledFor.toISOString(),
    startedAt: event.startedAt?.toISOString() ?? null,
    completedAt: event.completedAt?.toISOString() ?? null,
    status: event.status,
    notes: event.notes,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
  };
}

export function toMaintenanceEventAuditSnapshot(event: MaintenanceEvent): Record<string, unknown> {
  return {
    maintenanceScheduleId: event.maintenanceScheduleId,
    machineId: event.machineId,
    performedById: event.performedById,
    machineLogId: event.machineLogId,
    scheduledFor: event.scheduledFor,
    startedAt: event.startedAt,
    completedAt: event.completedAt,
    status: event.status,
  };
}
