/**
 * What a machine log is about: the machine as a whole system, or one of its
 * parts. Both kinds live in `machine_logs` so a machine has one history.
 * PostgreSQL enum type: `log_scope`.
 */
export enum LogScope {
  /** The whole machine system (its own state, e.g. planned maintenance). */
  MACHINE = 'MACHINE',
  /** A single part of the machine (`machinePartId` is set). */
  PART = 'PART',
}

export const LOG_SCOPES: readonly LogScope[] = Object.values(LogScope);
