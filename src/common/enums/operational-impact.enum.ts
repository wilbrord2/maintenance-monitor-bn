/**
 * Whether a part's current condition prevents the machine from operating.
 *
 * Status and impact are separate concepts: two parts with the same status
 * (e.g. UNDER_MAINTENANCE) can affect the machine differently.
 * PostgreSQL enum type: `operational_impact`.
 */
export enum OperationalImpact {
  /** The machine can keep running despite this part's condition. */
  NON_BLOCKING = 'NON_BLOCKING',
  /** This part's condition stops the machine. */
  BLOCKING = 'BLOCKING',
}

export const OPERATIONAL_IMPACTS: readonly OperationalImpact[] = Object.values(OperationalImpact);
