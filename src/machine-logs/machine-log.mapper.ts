import { type LogScope } from '../common/enums/log-scope.enum';
import { type LogStatus } from '../common/enums/log-status.enum';
import { type MachineOperationalStatus } from '../common/enums/machine-operational-status.enum';
import { type MachineState } from '../common/enums/machine-state.enum';
import { type OperationalImpact } from '../common/enums/operational-impact.enum';
import { toMachinePartRef, type MachinePartRef } from '../machine-parts/machine-part.mapper';
import { type MachineStatusSummary, toMachineStatusSummary } from '../machines/machine.mapper';
import { toUserSummary, type UserSummary } from '../users/user.mapper';
import { type MachineLog } from './machine-log.entity';

export interface MachineLogResponse {
  readonly id: number;
  /** The machine with its current (synced) status. */
  readonly machine: MachineStatusSummary;
  readonly scope: LogScope;
  /** The part this log concerns; null for whole-machine logs. */
  readonly machinePart: MachinePartRef | null;
  readonly technician: UserSummary;
  readonly faultDescription: string;
  readonly causeDescription: string | null;
  readonly entryStatus: MachineState;
  readonly remedyAction: string | null;
  readonly resultingState: MachineState;
  readonly operationalImpact: OperationalImpact | null;
  readonly machineStatusBefore: MachineState;
  readonly machineStatusAfter: MachineState;
  readonly operationalStatusBefore: MachineOperationalStatus;
  readonly operationalStatusAfter: MachineOperationalStatus;
  readonly downtimeHours: number;
  readonly logStatus: LogStatus;
  readonly nextMaintenancePlan: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Requires the `machine`, `machinePart` and `user` relations to be loaded. */
export function toMachineLogResponse(log: MachineLog): MachineLogResponse {
  if (!log.machine || !log.user) {
    throw new Error(`Machine log ${log.id} was mapped without its machine/user relations`);
  }
  if (log.machinePartId !== null && !log.machinePart) {
    throw new Error(`Machine log ${log.id} was mapped without its machinePart relation`);
  }
  return {
    id: log.id,
    machine: toMachineStatusSummary(log.machine),
    scope: log.scope,
    machinePart: log.machinePart ? toMachinePartRef(log.machinePart) : null,
    technician: toUserSummary(log.user),
    faultDescription: log.faultDescription,
    causeDescription: log.causeDescription,
    entryStatus: log.entryStatus,
    remedyAction: log.remedyAction,
    resultingState: log.resultingState,
    operationalImpact: log.operationalImpact,
    machineStatusBefore: log.machineStatusBefore,
    machineStatusAfter: log.machineStatusAfter,
    operationalStatusBefore: log.operationalStatusBefore,
    operationalStatusAfter: log.operationalStatusAfter,
    downtimeHours: log.downtimeHours,
    logStatus: log.logStatus,
    nextMaintenancePlan: log.nextMaintenancePlan,
    startedAt: log.startedAt.toISOString(),
    endedAt: log.endedAt?.toISOString() ?? null,
    version: log.version,
    createdAt: log.createdAt.toISOString(),
    updatedAt: log.updatedAt.toISOString(),
  };
}

export function toMachineLogAuditSnapshot(log: MachineLog): Record<string, unknown> {
  return {
    machineId: log.machineId,
    scope: log.scope,
    machinePartId: log.machinePartId,
    userId: log.userId,
    faultDescription: log.faultDescription,
    causeDescription: log.causeDescription,
    entryStatus: log.entryStatus,
    remedyAction: log.remedyAction,
    resultingState: log.resultingState,
    operationalImpact: log.operationalImpact,
    downtimeHours: log.downtimeHours,
    logStatus: log.logStatus,
    nextMaintenancePlan: log.nextMaintenancePlan,
    startedAt: log.startedAt,
    endedAt: log.endedAt,
  };
}
