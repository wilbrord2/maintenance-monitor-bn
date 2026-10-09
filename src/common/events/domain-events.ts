import { type LogScope } from '../enums/log-scope.enum';
import { type LogStatus } from '../enums/log-status.enum';
import { type MachineOperationalStatus } from '../enums/machine-operational-status.enum';
import { type MachineState } from '../enums/machine-state.enum';
import { type MaintenanceScheduleState } from '../enums/maintenance.enums';
import { type OperationalImpact } from '../enums/operational-impact.enum';

export const MACHINE_STATUS_UPDATED = 'machine.status.updated';
export const MACHINE_OPERATIONAL_STATUS_UPDATED = 'machine.operational-status.updated';
export const MACHINE_PART_UPDATED = 'machine.part.updated';
export const MAINTENANCE_REMINDER = 'maintenance.reminder';
export const MAINTENANCE_COMPLETED = 'maintenance.completed';

/** What caused the machine's status to be recalculated. */
export interface MachineStatusTrigger {
  readonly type: 'MACHINE_PART' | 'MACHINE_LOG' | 'MAINTENANCE_EVENT';
  readonly partId?: number;
  readonly logId?: number;
  /** For MACHINE_LOG triggers: whether the log concerns the whole machine or a part. */
  readonly scope?: LogScope;
  readonly maintenanceEventId?: number;
}

/**
 * Change of the machine's effective status (the most severe of its system
 * status and its part statuses).
 */
export interface MachineStatusUpdatedEvent {
  readonly machineId: number;
  readonly machineName: string;
  readonly serialNumber: string;
  readonly previousStatus: MachineState;
  readonly newStatus: MachineState;
  readonly reason: string;
  readonly trigger: MachineStatusTrigger;
  readonly updatedBy: { readonly id: number; readonly name: string };
  /** The log that caused the change, when there is one. */
  readonly logId: number | null;
  readonly timestamp: string;
}

/** Change of the derived operational status (OPERATING / WITH_DEFECTS / NOT_OPERATING). */
export interface MachineOperationalStatusUpdatedEvent {
  readonly machineId: number;
  readonly machineName: string;
  readonly serialNumber: string;
  readonly previousStatus: MachineOperationalStatus;
  readonly newStatus: MachineOperationalStatus;
  readonly reason: string;
  readonly trigger: MachineStatusTrigger;
  readonly updatedBy: { readonly id: number; readonly name: string };
  readonly timestamp: string;
}

/** A part's condition changed. */
export interface MachinePartUpdatedEvent {
  readonly machineId: number;
  readonly partId: number;
  readonly partCode: string;
  readonly partName: string;
  readonly previousStatus: MachineState;
  readonly newStatus: MachineState;
  readonly operationalImpact: OperationalImpact;
  readonly isCritical: boolean;
  readonly logId: number;
  readonly logStatus: LogStatus;
  readonly updatedBy: { readonly id: number; readonly name: string };
  readonly timestamp: string;
}

/** Preventive maintenance is approaching, due or overdue. */
export interface MaintenanceReminderEvent {
  readonly scheduleId: number;
  readonly machineId: number;
  readonly machineName: string;
  readonly serialNumber: string;
  readonly state: MaintenanceScheduleState;
  readonly nextMaintenanceAt: string;
  readonly daysUntilDue: number;
  readonly timestamp: string;
}

/** Preventive maintenance was completed; the next cycle starts from this moment. */
export interface MaintenanceCompletedEvent {
  readonly scheduleId: number | null;
  readonly eventId: number;
  readonly machineId: number;
  readonly machineName: string;
  readonly completedAt: string;
  readonly nextMaintenanceAt: string | null;
  readonly performedBy: { readonly id: number; readonly name: string } | null;
  readonly timestamp: string;
}

/** Registry of domain events and their payloads. Add new events here. */
export interface DomainEventMap {
  [MACHINE_STATUS_UPDATED]: MachineStatusUpdatedEvent;
  [MACHINE_OPERATIONAL_STATUS_UPDATED]: MachineOperationalStatusUpdatedEvent;
  [MACHINE_PART_UPDATED]: MachinePartUpdatedEvent;
  [MAINTENANCE_REMINDER]: MaintenanceReminderEvent;
  [MAINTENANCE_COMPLETED]: MaintenanceCompletedEvent;
}

export type DomainEventName = keyof DomainEventMap;
