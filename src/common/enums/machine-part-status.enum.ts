import { MachineState } from './machine-state.enum';

/**
 * Machine parts use the same four statuses as the existing machine workflow
 * (ACTIVE, UNDER_MAINTENANCE, DOWNTIME, UNDER_TEST) and therefore share the
 * `machine_state` PostgreSQL enum. These aliases exist for readability at call
 * sites that talk about parts; no second enum is introduced.
 */
export const MachinePartStatus = MachineState;
export type MachinePartStatus = MachineState;
