import { type MachineOperationalStatus } from '../common/enums/machine-operational-status.enum';
import { type MachineState } from '../common/enums/machine-state.enum';
import {
  toMachinePartResponse,
  toPartMaintenanceSummary,
  type MachinePartResponse,
} from '../machine-parts/machine-part.mapper';
import { type MachinePart } from '../machine-parts/machine-part.entity';
import { EMPTY_PART_SUMMARY, type MachinePartSummary } from '../machine-parts/machine-parts.repository';
import {
  toMaintenanceScheduleResponse,
  type MaintenanceScheduleResponse,
} from '../maintenance/maintenance.mapper';
import { type MaintenanceSchedule } from '../maintenance/maintenance-schedule.entity';
import { type Machine } from './machine.entity';
import { EMPTY_ACTIVITY, type MachineActivitySummary } from './machines.repository';

export interface MachineResponse {
  readonly id: number;
  readonly name: string;
  readonly serialNumber: string;
  /** Effective status: the most severe of the system status and the part statuses. */
  readonly status: MachineState;
  /** State of the machine as a whole system (set by whole-machine logs). */
  readonly systemStatus: MachineState;
  /** Derived from the parts and the system status; the backend is the only source. */
  readonly operationalStatus: MachineOperationalStatus;
  readonly description: string | null;
  readonly isActive: boolean;
  readonly activity: {
    readonly totalLogs: number;
    readonly openLogs: number;
    readonly lastActivityAt: string | null;
  };
  readonly parts: {
    readonly total: number;
    readonly active: number;
    readonly underMaintenance: number;
    readonly downtime: number;
    readonly underTest: number;
    /** Parts whose current condition stops the machine. */
    readonly blocking: number;
    readonly critical: number;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toMachineResponse(
  machine: Machine,
  activity: MachineActivitySummary = EMPTY_ACTIVITY,
  parts: MachinePartSummary = EMPTY_PART_SUMMARY,
): MachineResponse {
  return {
    id: machine.id,
    name: machine.name,
    serialNumber: machine.serialNumber,
    status: machine.status,
    systemStatus: machine.systemStatus,
    operationalStatus: machine.operationalStatus,
    description: machine.description,
    isActive: machine.isActive,
    activity: {
      totalLogs: activity.totalLogs,
      openLogs: activity.openLogs,
      lastActivityAt: activity.lastActivityAt?.toISOString() ?? null,
    },
    parts: {
      total: parts.total,
      active: parts.active,
      underMaintenance: parts.underMaintenance,
      downtime: parts.downtime,
      underTest: parts.underTest,
      blocking: parts.blocking,
      critical: parts.critical,
    },
    createdAt: machine.createdAt.toISOString(),
    updatedAt: machine.updatedAt.toISOString(),
  };
}

export function toMachineAuditSnapshot(machine: Machine): Record<string, unknown> {
  return {
    name: machine.name,
    serialNumber: machine.serialNumber,
    description: machine.description,
    status: machine.status,
    systemStatus: machine.systemStatus,
    operationalStatus: machine.operationalStatus,
    isActive: machine.isActive,
  };
}

/**
 * Machine details: the machine (including its resolved operational status), the
 * individual part conditions it was derived from, and its maintenance tasks
 * (machine-wide and per part).
 * Clients display `operationalStatus`; they never recompute it.
 */
export interface MachineDetailResponse extends MachineResponse {
  readonly partDetails: readonly MachinePartResponse[];
  readonly maintenanceSchedules: readonly MaintenanceScheduleResponse[];
}

export function toMachineDetailResponse(input: {
  machine: Machine;
  activity?: MachineActivitySummary;
  partSummary?: MachinePartSummary;
  parts: readonly MachinePart[];
  schedules: readonly MaintenanceSchedule[];
  now: Date;
}): MachineDetailResponse {
  // Schedules arrive ordered by due date, so the first active one per part is the next.
  const nextByPart = new Map<number, MaintenanceSchedule>();
  for (const schedule of input.schedules) {
    if (schedule.isActive && schedule.machinePartId !== null && !nextByPart.has(schedule.machinePartId)) {
      nextByPart.set(schedule.machinePartId, schedule);
    }
  }
  return {
    ...toMachineResponse(
      input.machine,
      input.activity ?? EMPTY_ACTIVITY,
      input.partSummary ?? EMPTY_PART_SUMMARY,
    ),
    partDetails: input.parts.map((part) =>
      toMachinePartResponse(part, toPartMaintenanceSummary(nextByPart.get(part.id), input.now)),
    ),
    maintenanceSchedules: input.schedules.map((schedule) =>
      toMaintenanceScheduleResponse(schedule, input.now),
    ),
  };
}

export interface MachineSummary {
  readonly id: number;
  readonly name: string;
  readonly serialNumber: string;
}

export function toMachineSummary(machine: Pick<Machine, 'id' | 'name' | 'serialNumber'>): MachineSummary {
  return { id: machine.id, name: machine.name, serialNumber: machine.serialNumber };
}

/** A machine summary with its current (synced) status. */
export interface MachineStatusSummary extends MachineSummary {
  readonly status: MachineState;
  readonly systemStatus: MachineState;
  readonly operationalStatus: MachineOperationalStatus;
}

export function toMachineStatusSummary(
  machine: Pick<Machine, 'id' | 'name' | 'serialNumber' | 'status' | 'systemStatus' | 'operationalStatus'>,
): MachineStatusSummary {
  return {
    ...toMachineSummary(machine),
    status: machine.status,
    systemStatus: machine.systemStatus,
    operationalStatus: machine.operationalStatus,
  };
}
