import {
  type MaintenanceEventStatus,
  type MaintenanceScheduleState,
} from '../common/enums/maintenance.enums';
import { type MachinePart } from '../machine-parts/machine-part.entity';
import { toMachineSummary, type MachineSummary } from '../machines/machine.mapper';
import { toUserSummary, type UserSummary } from '../users/user.mapper';
import { type MaintenanceEvent } from './maintenance-event.entity';
import { type MaintenanceSchedule } from './maintenance-schedule.entity';
import { resolveScheduleStatus } from './policies/maintenance-cycle';

export interface MaintenancePartSummary {
  readonly id: number;
  readonly name: string;
  readonly partCode: string;
}

export function toMaintenancePartSummary(
  part: Pick<MachinePart, 'id' | 'name' | 'partCode'>,
): MaintenancePartSummary {
  return { id: part.id, name: part.name, partCode: part.partCode };
}

export interface MaintenanceScheduleResponse {
  readonly id: number;
  readonly machineId: number;
  readonly machine: MachineSummary | null;
  /** Null for a machine-wide task. */
  readonly machinePartId: number | null;
  readonly machinePart: MaintenancePartSummary | null;
  readonly taskName: string;
  readonly description: string | null;
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
    machinePartId: schedule.machinePartId,
    machinePart: schedule.machinePart ? toMaintenancePartSummary(schedule.machinePart) : null,
    taskName: schedule.taskName,
    description: schedule.description,
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
    machinePartId: schedule.machinePartId,
    taskName: schedule.taskName,
    description: schedule.description,
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
  /** The schedule's task; null for one-off maintenance. */
  readonly taskName: string | null;
  readonly machine: MachineSummary | null;
  readonly machinePartId: number | null;
  readonly machinePart: MaintenancePartSummary | null;
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
    taskName: event.maintenanceSchedule?.taskName ?? null,
    machine: event.machine ? toMachineSummary(event.machine) : null,
    machinePartId: event.machinePartId,
    machinePart: event.machinePart ? toMaintenancePartSummary(event.machinePart) : null,
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
    machinePartId: event.machinePartId,
    performedById: event.performedById,
    machineLogId: event.machineLogId,
    scheduledFor: event.scheduledFor,
    startedAt: event.startedAt,
    completedAt: event.completedAt,
    status: event.status,
  };
}
