import { LogStatus } from '../../common/enums/log-status.enum';
import { MachineState } from '../../common/enums/machine-state.enum';
import { type AppError } from '../../common/errors/app-error';
import { type LogCandidate, MachineLogRules } from './machine-log-rules.policy';

const NOW = new Date('2026-09-01T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function errorOf(candidate: LogCandidate, isLatest = true): AppError | null {
  try {
    new MachineLogRules().validate(candidate, { isLatest, now: NOW });
    return null;
  } catch (error) {
    return error as AppError;
  }
}

const base: LogCandidate = {
  resultingState: MachineState.ACTIVE,
  logStatus: LogStatus.CLOSED,
  startedAt: hoursAgo(3),
  endedAt: hoursAgo(1),
};

describe('MachineLogRules', () => {
  it('accepts a consistent closed log', () => {
    expect(errorOf(base)).toBeNull();
    expect(errorOf({ ...base, downtimeHours: 2 })).toBeNull();
  });

  it('rejects an end time before the start time', () => {
    expect(errorOf({ ...base, endedAt: hoursAgo(4) })).toMatchObject({ code: 'INVALID_LOG_TIMES' });
  });

  it('rejects timestamps in the future beyond the clock-skew tolerance', () => {
    expect(
      errorOf({
        ...base,
        startedAt: new Date(NOW.getTime() + 60_000),
        endedAt: null,
        logStatus: LogStatus.OPEN,
      }),
    ).toBeNull();
    expect(
      errorOf({
        ...base,
        startedAt: new Date(NOW.getTime() + 3_600_000),
        endedAt: null,
        logStatus: LogStatus.OPEN,
      }),
    ).toMatchObject({ code: 'INVALID_LOG_TIMES', details: [{ field: 'startedAt' }] });
  });

  it('requires OPEN logs to have no end time and CLOSED logs to have one', () => {
    expect(errorOf({ ...base, logStatus: LogStatus.OPEN })).toMatchObject({ code: 'INVALID_LOG_STATUS' });
    expect(errorOf({ ...base, endedAt: null })).toMatchObject({ code: 'INVALID_LOG_STATUS' });
  });

  it.each([MachineState.DOWNTIME, MachineState.UNDER_MAINTENANCE])(
    'refuses to close the latest log while it leaves the machine in %s',
    (resultingState) => {
      expect(errorOf({ ...base, resultingState })).toMatchObject({
        statusCode: 422,
        code: 'INVALID_LOG_STATUS',
        details: [{ field: 'logStatus' }],
      });
      // A historical log (the machine has since moved on) may be closed.
      expect(errorOf({ ...base, resultingState }, false)).toBeNull();
    },
  );

  it('allows closing a log that leaves the machine UNDER_TEST', () => {
    expect(errorOf({ ...base, resultingState: MachineState.UNDER_TEST })).toBeNull();
  });

  it('validates downtime against the event duration', () => {
    expect(errorOf({ ...base, downtimeHours: -1 })).toMatchObject({ code: 'INVALID_DOWNTIME' });
    expect(errorOf({ ...base, downtimeHours: 2.005 })).toBeNull();
    expect(errorOf({ ...base, downtimeHours: 2.5 })).toMatchObject({ code: 'INVALID_DOWNTIME' });
    expect(errorOf({ ...base, logStatus: LogStatus.OPEN, endedAt: null, downtimeHours: 500 })).toBeNull();
  });
});
