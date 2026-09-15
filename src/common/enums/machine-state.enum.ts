/**
 * Operational state of a machine. Shared by `machines.status` and the
 * `entry_status` / `resulting_state` columns of `machine_logs`
 * (a single PostgreSQL enum type: `machine_state`).
 */
export enum MachineState {
  ACTIVE = 'ACTIVE',
  UNDER_MAINTENANCE = 'UNDER_MAINTENANCE',
  DOWNTIME = 'DOWNTIME',
  UNDER_TEST = 'UNDER_TEST',
}

export const MACHINE_STATES: readonly MachineState[] = Object.values(MachineState);
