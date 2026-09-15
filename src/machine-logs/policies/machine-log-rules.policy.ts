import { LogStatus } from '../../common/enums/log-status.enum';
import { MachineState } from '../../common/enums/machine-state.enum';
import { AppError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';

export interface MachineLogRulesConfig {
  /**
   * Resulting states that mean the event is still ongoing: while a machine's
   * most recent log leaves it in one of these states, that log must stay OPEN.
   */
  readonly statesRequiringOpenLog: readonly MachineState[];
  /** Tolerated client clock skew for timestamps in the future. */
  readonly futureToleranceMs: number;
}

export const DEFAULT_MACHINE_LOG_RULES: MachineLogRulesConfig = {
  statesRequiringOpenLog: [MachineState.DOWNTIME, MachineState.UNDER_MAINTENANCE],
  futureToleranceMs: 5 * 60 * 1000,
};

export interface LogCandidate {
  readonly resultingState: MachineState;
  readonly logStatus: LogStatus;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly downtimeHours?: number;
}

export interface LogRuleContext {
  /** Whether the log is (or will be) the machine's most recent log and so defines its current status. */
  readonly isLatest: boolean;
  readonly now: Date;
}

const MS_PER_HOUR = 3_600_000;

/**
 * Centralised consistency rules between log status, resulting state,
 * timestamps and downtime. Applied to the final state of a log on create and update.
 */
export class MachineLogRules {
  constructor(private readonly config: MachineLogRulesConfig = DEFAULT_MACHINE_LOG_RULES) {}

  validate(candidate: LogCandidate, context: LogRuleContext): void {
    const latestAllowed = context.now.getTime() + this.config.futureToleranceMs;

    if (candidate.startedAt.getTime() > latestAllowed) {
      throw this.timesError('startedAt', 'cannot be in the future');
    }
    if (candidate.endedAt) {
      if (candidate.endedAt.getTime() > latestAllowed)
        throw this.timesError('endedAt', 'cannot be in the future');
      if (candidate.endedAt < candidate.startedAt)
        throw this.timesError('endedAt', 'cannot be before startedAt');
    }

    if (candidate.logStatus === LogStatus.OPEN && candidate.endedAt) {
      throw AppError.unprocessable('An open log cannot have an end time', ErrorCode.INVALID_LOG_STATUS, [
        { field: 'endedAt', message: 'must be empty while the log is OPEN' },
      ]);
    }
    if (candidate.logStatus === LogStatus.CLOSED && !candidate.endedAt) {
      throw AppError.unprocessable('A closed log requires an end time', ErrorCode.INVALID_LOG_STATUS, [
        { field: 'endedAt', message: 'is required when the log is CLOSED' },
      ]);
    }
    if (
      context.isLatest &&
      candidate.logStatus === LogStatus.CLOSED &&
      this.config.statesRequiringOpenLog.includes(candidate.resultingState)
    ) {
      throw AppError.unprocessable(
        `A log cannot be closed while it leaves the machine in ${candidate.resultingState}`,
        ErrorCode.INVALID_LOG_STATUS,
        [{ field: 'logStatus', message: `must be OPEN while resultingState is ${candidate.resultingState}` }],
      );
    }

    if (candidate.downtimeHours !== undefined) {
      if (!Number.isFinite(candidate.downtimeHours) || candidate.downtimeHours < 0) {
        throw this.downtimeError('cannot be negative');
      }
      if (candidate.endedAt) {
        const durationHours = (candidate.endedAt.getTime() - candidate.startedAt.getTime()) / MS_PER_HOUR;
        // One-hundredth of an hour of tolerance for rounding of client-supplied values.
        if (candidate.downtimeHours > durationHours + 0.01) {
          throw this.downtimeError('cannot exceed the time between startedAt and endedAt');
        }
      }
    }
  }

  private timesError(field: string, message: string): AppError {
    return AppError.unprocessable(`${field} ${message}`, ErrorCode.INVALID_LOG_TIMES, [{ field, message }]);
  }

  private downtimeError(message: string): AppError {
    return AppError.unprocessable(`downtimeHours ${message}`, ErrorCode.INVALID_DOWNTIME, [
      { field: 'downtimeHours', message },
    ]);
  }
}
