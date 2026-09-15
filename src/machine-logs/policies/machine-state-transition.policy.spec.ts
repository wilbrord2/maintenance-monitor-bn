import { MACHINE_STATES, MachineState } from '../../common/enums/machine-state.enum';
import { AppError } from '../../common/errors/app-error';
import {
  DEFAULT_MACHINE_STATE_TRANSITIONS,
  MachineStateTransitionPolicy,
} from './machine-state-transition.policy';

const { ACTIVE, UNDER_MAINTENANCE, DOWNTIME, UNDER_TEST } = MachineState;

describe('MachineStateTransitionPolicy', () => {
  const policy = new MachineStateTransitionPolicy();

  it.each([
    [ACTIVE, UNDER_MAINTENANCE],
    [ACTIVE, DOWNTIME],
    [ACTIVE, UNDER_TEST],
    [UNDER_MAINTENANCE, UNDER_TEST],
    [UNDER_MAINTENANCE, ACTIVE],
    [UNDER_MAINTENANCE, DOWNTIME],
    [UNDER_TEST, ACTIVE],
    [UNDER_TEST, UNDER_MAINTENANCE],
    [UNDER_TEST, DOWNTIME],
    [DOWNTIME, UNDER_MAINTENANCE],
    [DOWNTIME, UNDER_TEST],
    [DOWNTIME, ACTIVE],
  ])('allows %s -> %s by default', (from, to) => {
    expect(policy.isAllowed(from, to)).toBe(true);
  });

  it('allows same-state entries by default and lists them first', () => {
    for (const state of MACHINE_STATES) expect(policy.isAllowed(state, state)).toBe(true);
    expect(policy.allowedTargets(DOWNTIME)[0]).toBe(DOWNTIME);
  });

  it('can forbid same-state entries', () => {
    const strict = new MachineStateTransitionPolicy(DEFAULT_MACHINE_STATE_TRANSITIONS, {
      allowSameStateEntries: false,
    });
    expect(strict.isAllowed(ACTIVE, ACTIVE)).toBe(false);
    expect(strict.allowedTargets(ACTIVE)).not.toContain(ACTIVE);
  });

  it('enforces a customised table and explains the rejection', () => {
    const custom = new MachineStateTransitionPolicy(
      {
        [ACTIVE]: [DOWNTIME],
        [DOWNTIME]: [UNDER_MAINTENANCE],
        [UNDER_MAINTENANCE]: [UNDER_TEST],
        [UNDER_TEST]: [ACTIVE],
      },
      { allowSameStateEntries: false },
    );
    expect(custom.isAllowed(DOWNTIME, ACTIVE)).toBe(false);
    try {
      custom.assertAllowed(DOWNTIME, ACTIVE);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        statusCode: 422,
        code: 'INVALID_STATE_TRANSITION',
        message: 'Invalid state transition from DOWNTIME to ACTIVE',
        details: [{ field: 'resultingState', message: 'allowed from DOWNTIME: UNDER_MAINTENANCE' }],
      });
    }
  });

  it('rejects incomplete tables at construction', () => {
    expect(() => new MachineStateTransitionPolicy({ [ACTIVE]: [DOWNTIME] } as never)).toThrow(
      /missing state/,
    );
  });

  it('describes the full rule set', () => {
    const description = policy.describe();
    expect(Object.keys(description.transitions).sort()).toEqual([...MACHINE_STATES].sort());
    expect(description.allowSameStateEntries).toBe(true);
  });
});
