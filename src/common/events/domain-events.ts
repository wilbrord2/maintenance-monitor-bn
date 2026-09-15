import { type MachineState } from '../enums/machine-state.enum';

export const MACHINE_STATUS_UPDATED = 'machine.status.updated';

export type MachineStatusChangeSource = 'MACHINE_LOG_CREATED' | 'MACHINE_LOG_UPDATED' | 'MACHINE_LOG_DELETED';

export interface MachineStatusUpdatedEvent {
  readonly machineId: number;
  readonly machineName: string;
  readonly serialNumber: string;
  readonly previousStatus: MachineState;
  readonly newStatus: MachineState;
  readonly updatedBy: { readonly id: number; readonly name: string };
  readonly logId: number;
  readonly source: MachineStatusChangeSource;
  readonly timestamp: string;
}

/** Registry of domain events and their payloads. Add new events here. */
export interface DomainEventMap {
  [MACHINE_STATUS_UPDATED]: MachineStatusUpdatedEvent;
}

export type DomainEventName = keyof DomainEventMap;
