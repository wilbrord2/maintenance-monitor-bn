import { type LogStatus } from '../common/enums/log-status.enum';
import { type MachineState } from '../common/enums/machine-state.enum';
import { type MachineSummary, toMachineSummary } from '../machines/machine.mapper';
import { toUserSummary, type UserSummary } from '../users/user.mapper';
import { type MachineLog } from './machine-log.entity';

export interface MachineLogResponse {
  readonly id: number;
  readonly machine: MachineSummary;
  readonly technician: UserSummary;
  readonly faultDescription: string;
  readonly causeDescription: string | null;
  readonly entryStatus: MachineState;
  readonly remedyAction: string | null;
  readonly resultingState: MachineState;
  readonly downtimeHours: number;
  readonly logStatus: LogStatus;
  readonly nextMaintenancePlan: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Requires the `machine` and `user` relations to be loaded. */
export function toMachineLogResponse(log: MachineLog): MachineLogResponse {
  if (!log.machine || !log.user) {
    throw new Error(`Machine log ${log.id} was mapped without its machine/user relations`);
  }
  return {
    id: log.id,
    machine: toMachineSummary(log.machine),
    technician: toUserSummary(log.user),
    faultDescription: log.faultDescription,
    causeDescription: log.causeDescription,
    entryStatus: log.entryStatus,
    remedyAction: log.remedyAction,
    resultingState: log.resultingState,
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
    userId: log.userId,
    faultDescription: log.faultDescription,
    causeDescription: log.causeDescription,
    entryStatus: log.entryStatus,
    remedyAction: log.remedyAction,
    resultingState: log.resultingState,
    downtimeHours: log.downtimeHours,
    logStatus: log.logStatus,
    nextMaintenancePlan: log.nextMaintenancePlan,
    startedAt: log.startedAt,
    endedAt: log.endedAt,
  };
}
