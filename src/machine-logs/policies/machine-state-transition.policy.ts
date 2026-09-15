import { MACHINE_STATES, MachineState } from '../../common/enums/machine-state.enum';
import { AppError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';

export type TransitionTable = Readonly<Record<MachineState, readonly MachineState[]>>;

/**
 * The single source of truth for which machine-state changes are permitted.
 * Edit this table (or inject another into the policy) to change the rules.
 */
export const DEFAULT_MACHINE_STATE_TRANSITIONS: TransitionTable = {
  [MachineState.ACTIVE]: [MachineState.UNDER_MAINTENANCE, MachineState.DOWNTIME, MachineState.UNDER_TEST],
  [MachineState.UNDER_MAINTENANCE]: [MachineState.UNDER_TEST, MachineState.ACTIVE, MachineState.DOWNTIME],
  [MachineState.UNDER_TEST]: [MachineState.ACTIVE, MachineState.UNDER_MAINTENANCE, MachineState.DOWNTIME],
  [MachineState.DOWNTIME]: [MachineState.UNDER_MAINTENANCE, MachineState.UNDER_TEST, MachineState.ACTIVE],
};

export interface MachineStateTransitionOptions {
  /**
   * Whether a log may keep the machine in its current state (e.g. an
   * inspection on an ACTIVE machine that stays ACTIVE). Such entries record
   * activity without changing status.
   */
  readonly allowSameStateEntries: boolean;
}

export const DEFAULT_TRANSITION_OPTIONS: MachineStateTransitionOptions = { allowSameStateEntries: true };

export class MachineStateTransitionPolicy {
  constructor(
    private readonly table: TransitionTable = DEFAULT_MACHINE_STATE_TRANSITIONS,
    private readonly options: MachineStateTransitionOptions = DEFAULT_TRANSITION_OPTIONS,
  ) {
    for (const state of MACHINE_STATES) {
      if (!Array.isArray(table[state])) throw new Error(`Transition table is missing state ${state}`);
    }
  }

  isAllowed(from: MachineState, to: MachineState): boolean {
    if (from === to) return this.options.allowSameStateEntries;
    return this.table[from].includes(to);
  }

  allowedTargets(from: MachineState): MachineState[] {
    const targets = [...this.table[from]];
    return this.options.allowSameStateEntries ? [from, ...targets] : targets;
  }

  assertAllowed(from: MachineState, to: MachineState): void {
    if (this.isAllowed(from, to)) return;
    throw AppError.unprocessable(
      `Invalid state transition from ${from} to ${to}`,
      ErrorCode.INVALID_STATE_TRANSITION,
      [
        {
          field: 'resultingState',
          message: `allowed from ${from}: ${this.allowedTargets(from).join(', ') || 'none'}`,
        },
      ],
    );
  }

  describe(): { allowSameStateEntries: boolean; transitions: Record<MachineState, MachineState[]> } {
    const transitions = {} as Record<MachineState, MachineState[]>;
    for (const state of MACHINE_STATES) transitions[state] = this.allowedTargets(state);
    return { allowSameStateEntries: this.options.allowSameStateEntries, transitions };
  }
}
