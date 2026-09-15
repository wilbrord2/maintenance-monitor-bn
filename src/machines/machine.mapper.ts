import { type MachineState } from '../common/enums/machine-state.enum';
import { type Machine } from './machine.entity';
import { EMPTY_ACTIVITY, type MachineActivitySummary } from './machines.repository';

export interface MachineResponse {
  readonly id: number;
  readonly name: string;
  readonly serialNumber: string;
  readonly status: MachineState;
  readonly description: string | null;
  readonly isActive: boolean;
  readonly activity: {
    readonly totalLogs: number;
    readonly openLogs: number;
    readonly lastActivityAt: string | null;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toMachineResponse(
  machine: Machine,
  activity: MachineActivitySummary = EMPTY_ACTIVITY,
): MachineResponse {
  return {
    id: machine.id,
    name: machine.name,
    serialNumber: machine.serialNumber,
    status: machine.status,
    description: machine.description,
    isActive: machine.isActive,
    activity: {
      totalLogs: activity.totalLogs,
      openLogs: activity.openLogs,
      lastActivityAt: activity.lastActivityAt?.toISOString() ?? null,
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
    isActive: machine.isActive,
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
