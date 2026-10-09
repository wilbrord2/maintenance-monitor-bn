/**
 * Whether the machine as a whole can operate. Derived by MachineStatusResolver
 * from its parts and its own maintenance workflow state — never set directly.
 *
 * Deliberately separate from `MachineState` (the part/workflow statuses).
 * PostgreSQL enum type: `machine_operational_status`.
 */
export enum MachineOperationalStatus {
  OPERATING = 'OPERATING',
  OPERATING_WITH_DEFECTS = 'OPERATING_WITH_DEFECTS',
  NOT_OPERATING = 'NOT_OPERATING',
}

export const MACHINE_OPERATIONAL_STATUSES: readonly MachineOperationalStatus[] =
  Object.values(MachineOperationalStatus);
