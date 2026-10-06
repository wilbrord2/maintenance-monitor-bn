import { MachineState } from '../common/enums/machine-state.enum';
import { OperationalImpact } from '../common/enums/operational-impact.enum';
import { type MachinePart } from './machine-part.entity';

export interface MachinePartResponse {
  readonly id: number;
  readonly machineId: number;
  readonly name: string;
  readonly partCode: string;
  readonly description: string | null;
  readonly status: MachineState;
  readonly operationalImpact: OperationalImpact;
  readonly isCritical: boolean;
  readonly isActive: boolean;
  /** True when the part is not ACTIVE (a defect the machine is running with, or a stoppage). */
  readonly hasDefect: boolean;
  /** True when this part's current condition stops the machine. */
  readonly isBlockingMachine: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toMachinePartResponse(part: MachinePart): MachinePartResponse {
  const hasDefect = part.status !== MachineState.ACTIVE;
  return {
    id: part.id,
    machineId: part.machineId,
    name: part.name,
    partCode: part.partCode,
    description: part.description,
    status: part.status,
    operationalImpact: part.operationalImpact,
    isCritical: part.isCritical,
    isActive: part.isActive,
    hasDefect,
    isBlockingMachine: hasDefect && part.isActive && part.operationalImpact === OperationalImpact.BLOCKING,
    createdAt: part.createdAt.toISOString(),
    updatedAt: part.updatedAt.toISOString(),
  };
}

export function toMachinePartAuditSnapshot(part: MachinePart): Record<string, unknown> {
  return {
    machineId: part.machineId,
    name: part.name,
    partCode: part.partCode,
    description: part.description,
    status: part.status,
    operationalImpact: part.operationalImpact,
    isCritical: part.isCritical,
    isActive: part.isActive,
  };
}

export interface MachinePartRef {
  readonly id: number;
  readonly partCode: string;
  readonly name: string;
  readonly isCritical: boolean;
}

export function toMachinePartRef(
  part: Pick<MachinePart, 'id' | 'partCode' | 'name' | 'isCritical'>,
): MachinePartRef {
  return { id: part.id, partCode: part.partCode, name: part.name, isCritical: part.isCritical };
}
