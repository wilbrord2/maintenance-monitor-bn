import { MachineOperationalStatus } from '../common/enums/machine-operational-status.enum';
import { MachineState } from '../common/enums/machine-state.enum';
import { OperationalImpact } from '../common/enums/operational-impact.enum';

/** The condition of one part, as far as machine status resolution is concerned. */
export interface PartCondition {
  readonly id: number;
  readonly partCode: string;
  readonly status: MachineState;
  readonly operationalImpact: OperationalImpact;
  /** Deactivated parts (e.g. removed from the machine) are ignored. */
  readonly isActive: boolean;
}

export interface MachineStatusResolution {
  /**
   * The machine's effective status: the most severe of its own system state
   * and the status of each active part. ACTIVE only when nothing is wrong.
   */
  readonly machineStatus: MachineState;
  /** Whether the machine can run (blocking vs non-blocking conditions). */
  readonly status: MachineOperationalStatus;
  /** Human-readable explanation, recorded in audit entries and returned to clients. */
  readonly reason: string;
  /** Active parts whose condition stops the machine. */
  readonly blockingPartIds: readonly number[];
  /** Active parts with a condition that does not stop the machine. */
  readonly defectivePartIds: readonly number[];
}

/** How the machine's own workflow status contributes, independently of its parts. */
export type MachineStateContribution = 'NONE' | 'DEFECT' | 'BLOCKING';

/**
 * Machine-level maintenance and downtime stop the whole machine; a machine
 * under test runs with a defect. Centralised here so the rule can be changed
 * in one place.
 */
export const DEFAULT_MACHINE_STATE_CONTRIBUTIONS: Readonly<Record<MachineState, MachineStateContribution>> = {
  [MachineState.ACTIVE]: 'NONE',
  [MachineState.UNDER_MAINTENANCE]: 'BLOCKING',
  [MachineState.DOWNTIME]: 'BLOCKING',
  [MachineState.UNDER_TEST]: 'DEFECT',
};

/**
 * Severity used to pick the machine's effective status; higher wins. A machine
 * is DOWNTIME if anything is down, otherwise UNDER_MAINTENANCE if anything is
 * being maintained, and so on.
 */
export const MACHINE_STATUS_SEVERITY: Readonly<Record<MachineState, number>> = {
  [MachineState.ACTIVE]: 0,
  [MachineState.UNDER_TEST]: 1,
  [MachineState.UNDER_MAINTENANCE]: 2,
  [MachineState.DOWNTIME]: 3,
};

export interface MachineStatusInput {
  /** The state of the machine as a whole system (owned by MACHINE-scope logs). */
  readonly machineState: MachineState;
  readonly parts: readonly PartCondition[];
}

/**
 * The single source of truth for a machine's status and operational status.
 *
 * The machine status is the most severe of the machine's own system state and
 * every active part's status (see MACHINE_STATUS_SEVERITY), so a machine with a
 * defective part is never reported ACTIVE.
 *
 * A part contributes a *defect* whenever it is not ACTIVE, and *blocks* the
 * machine only when its current condition is BLOCKING. That is why two parts
 * with the same status can affect the machine differently, and why
 * `UNDER_MAINTENANCE` on one part does not by itself stop the machine.
 *
 *   any blocking condition            -> NOT_OPERATING
 *   otherwise any non-ACTIVE part     -> OPERATING_WITH_DEFECTS
 *   otherwise                         -> OPERATING
 *
 * Machines without parts resolve from their workflow status alone, so existing
 * machines keep a correct status until parts are configured.
 */
export class MachineStatusResolver {
  constructor(
    private readonly machineStateContributions: Readonly<
      Record<MachineState, MachineStateContribution>
    > = DEFAULT_MACHINE_STATE_CONTRIBUTIONS,
  ) {}

  resolve(input: MachineStatusInput): MachineStatusResolution {
    const parts = input.parts.filter((part) => part.isActive);
    const blocking = parts.filter(
      (part) => part.status !== MachineState.ACTIVE && part.operationalImpact === OperationalImpact.BLOCKING,
    );
    const defective = parts.filter((part) => part.status !== MachineState.ACTIVE);
    const machineContribution = this.machineStateContributions[input.machineState];
    const machineStatus = this.worstStatus(input.machineState, defective);

    const blockingPartIds = blocking.map((part) => part.id);
    const defectivePartIds = defective.map((part) => part.id);

    if (machineContribution === 'BLOCKING') {
      return {
        machineStatus,
        status: MachineOperationalStatus.NOT_OPERATING,
        reason: `Machine is ${this.describeState(input.machineState)}`,
        blockingPartIds,
        defectivePartIds,
      };
    }
    if (blocking.length > 0) {
      return {
        machineStatus,
        status: MachineOperationalStatus.NOT_OPERATING,
        reason: this.describeBlocking(blocking),
        blockingPartIds,
        defectivePartIds,
      };
    }
    if (defective.length > 0) {
      return {
        machineStatus,
        status: MachineOperationalStatus.OPERATING_WITH_DEFECTS,
        reason: this.describeDefects(defective),
        blockingPartIds,
        defectivePartIds,
      };
    }
    if (machineContribution === 'DEFECT') {
      return {
        machineStatus,
        status: MachineOperationalStatus.OPERATING_WITH_DEFECTS,
        reason: `Machine is ${this.describeState(input.machineState)}`,
        blockingPartIds,
        defectivePartIds,
      };
    }
    return {
      machineStatus,
      status: MachineOperationalStatus.OPERATING,
      reason: parts.length === 0 ? 'No parts configured; machine is active' : 'All parts are active',
      blockingPartIds,
      defectivePartIds,
    };
  }

  /** Exposes the rules for clients and documentation. */
  describe(): {
    machineStateContributions: Record<MachineState, MachineStateContribution>;
    statuses: MachineOperationalStatus[];
  } {
    return {
      machineStateContributions: { ...this.machineStateContributions },
      statuses: Object.values(MachineOperationalStatus),
    };
  }

  private worstStatus(systemState: MachineState, defective: readonly PartCondition[]): MachineState {
    return defective.reduce(
      (worst, part) =>
        MACHINE_STATUS_SEVERITY[part.status] > MACHINE_STATUS_SEVERITY[worst] ? part.status : worst,
      systemState,
    );
  }

  private describeState(state: MachineState): string {
    return state.toLowerCase().replace(/_/g, ' ');
  }

  private describeBlocking(parts: readonly PartCondition[]): string {
    const [first] = parts;
    if (!first) return 'A part condition stops the machine';
    const others = parts.length - 1;
    const suffix = others > 0 ? ` and ${others} other blocking part(s)` : '';
    return `Part ${first.partCode} is ${this.describeState(first.status)} and stops the machine${suffix}`;
  }

  private describeDefects(parts: readonly PartCondition[]): string {
    const codes = parts.map((part) => part.partCode).join(', ');
    return `${parts.length} part(s) with defects that do not stop the machine: ${codes}`;
  }
}
