import { MachineOperationalStatus } from '../common/enums/machine-operational-status.enum';
import { MachineState } from '../common/enums/machine-state.enum';
import { OperationalImpact } from '../common/enums/operational-impact.enum';
import { MachineStatusResolver, type PartCondition } from './machine-status.resolver';

const { ACTIVE, UNDER_MAINTENANCE, DOWNTIME, UNDER_TEST } = MachineState;
const { BLOCKING, NON_BLOCKING } = OperationalImpact;
const { OPERATING, OPERATING_WITH_DEFECTS, NOT_OPERATING } = MachineOperationalStatus;

let nextId = 0;
const part = (
  partCode: string,
  status: MachineState,
  operationalImpact: OperationalImpact = NON_BLOCKING,
  isActive = true,
): PartCondition => ({ id: (nextId += 1), partCode, status, operationalImpact, isActive });

const resolver = new MachineStatusResolver();
const resolve = (parts: PartCondition[], machineState: MachineState = ACTIVE) =>
  resolver.resolve({ machineState, parts });

describe('MachineStatusResolver', () => {
  it('OPERATING when all parts are active', () => {
    const result = resolve([part('A1', ACTIVE), part('A2', ACTIVE), part('A3', ACTIVE)]);
    expect(result.status).toBe(OPERATING);
    expect(result.blockingPartIds).toEqual([]);
    expect(result.defectivePartIds).toEqual([]);
    expect(result.reason).toBe('All parts are active');
  });

  it('OPERATING_WITH_DEFECTS for one non-blocking part under maintenance', () => {
    const a2 = part('A2', UNDER_MAINTENANCE, NON_BLOCKING);
    const result = resolve([part('A1', ACTIVE), a2, part('A3', ACTIVE)]);
    expect(result.status).toBe(OPERATING_WITH_DEFECTS);
    expect(result.defectivePartIds).toEqual([a2.id]);
    expect(result.blockingPartIds).toEqual([]);
    expect(result.reason).toContain('A2');
  });

  it('NOT_OPERATING for one blocking part under maintenance', () => {
    const a2 = part('A2', UNDER_MAINTENANCE, BLOCKING);
    const result = resolve([part('A1', ACTIVE), a2, part('A3', ACTIVE)]);
    expect(result.status).toBe(NOT_OPERATING);
    expect(result.blockingPartIds).toEqual([a2.id]);
    expect(result.reason).toBe('Part A2 is under maintenance and stops the machine');
  });

  it('OPERATING_WITH_DEFECTS for non-blocking downtime', () => {
    const result = resolve([part('A1', ACTIVE), part('A2', DOWNTIME, NON_BLOCKING), part('A3', ACTIVE)]);
    expect(result.status).toBe(OPERATING_WITH_DEFECTS);
  });

  it('NOT_OPERATING for blocking downtime', () => {
    const result = resolve([part('A1', ACTIVE), part('A2', DOWNTIME, BLOCKING), part('A3', ACTIVE)]);
    expect(result.status).toBe(NOT_OPERATING);
  });

  it('OPERATING_WITH_DEFECTS for several non-blocking conditions of different statuses', () => {
    const result = resolve([
      part('A1', ACTIVE),
      part('A2', UNDER_TEST, NON_BLOCKING),
      part('A3', UNDER_MAINTENANCE, NON_BLOCKING),
      part('A4', ACTIVE),
    ]);
    expect(result.status).toBe(OPERATING_WITH_DEFECTS);
    expect(result.defectivePartIds).toHaveLength(2);
  });

  it('NOT_OPERATING when one of many affected parts is blocking', () => {
    const blocker = part('A3', DOWNTIME, BLOCKING);
    const result = resolve([
      part('A1', ACTIVE),
      part('A2', UNDER_TEST, NON_BLOCKING),
      blocker,
      part('A4', UNDER_MAINTENANCE, NON_BLOCKING),
    ]);
    expect(result.status).toBe(NOT_OPERATING);
    expect(result.blockingPartIds).toEqual([blocker.id]);
    expect(result.defectivePartIds).toHaveLength(3);
  });

  it('NOT_OPERATING for a blocking part under test', () => {
    expect(resolve([part('A1', UNDER_TEST, BLOCKING), part('A2', ACTIVE)]).status).toBe(NOT_OPERATING);
  });

  it('recovers to OPERATING once the blocking part is repaired', () => {
    expect(resolve([part('A1', DOWNTIME, BLOCKING), part('A2', ACTIVE)]).status).toBe(NOT_OPERATING);
    expect(resolve([part('A1', ACTIVE), part('A2', ACTIVE)]).status).toBe(OPERATING);
  });

  it('recovers to OPERATING_WITH_DEFECTS when a non-blocking defect remains', () => {
    expect(
      resolve([part('A1', DOWNTIME, BLOCKING), part('A2', UNDER_MAINTENANCE, NON_BLOCKING)]).status,
    ).toBe(NOT_OPERATING);
    expect(resolve([part('A1', ACTIVE), part('A2', UNDER_MAINTENANCE, NON_BLOCKING)]).status).toBe(
      OPERATING_WITH_DEFECTS,
    );
  });

  it('counts every blocking part and names the first in the reason', () => {
    const result = resolve([part('A1', DOWNTIME, BLOCKING), part('A2', UNDER_MAINTENANCE, BLOCKING)]);
    expect(result.blockingPartIds).toHaveLength(2);
    expect(result.reason).toContain('and 1 other blocking part(s)');
  });

  describe('parts that are ignored', () => {
    it('ignores deactivated parts', () => {
      const result = resolve([part('A1', ACTIVE), part('A2', DOWNTIME, BLOCKING, false)]);
      expect(result.status).toBe(OPERATING);
      expect(result.blockingPartIds).toEqual([]);
    });

    it('treats a machine with no parts as operating', () => {
      const result = resolve([]);
      expect(result.status).toBe(OPERATING);
      expect(result.reason).toBe('No parts configured; machine is active');
    });
  });

  describe('machine workflow status', () => {
    it('machine-level maintenance or downtime stops the machine regardless of parts', () => {
      expect(resolve([part('A1', ACTIVE)], UNDER_MAINTENANCE).status).toBe(NOT_OPERATING);
      expect(resolve([part('A1', ACTIVE)], DOWNTIME).status).toBe(NOT_OPERATING);
      expect(resolve([], DOWNTIME).reason).toBe('Machine is downtime');
    });

    it('machine under test operates with defects', () => {
      expect(resolve([part('A1', ACTIVE)], UNDER_TEST).status).toBe(OPERATING_WITH_DEFECTS);
    });

    it('still reports blocking parts while the machine itself is down', () => {
      const blocker = part('A1', DOWNTIME, BLOCKING);
      const result = resolve([blocker], UNDER_MAINTENANCE);
      expect(result.status).toBe(NOT_OPERATING);
      expect(result.blockingPartIds).toEqual([blocker.id]);
    });

    it('part defects win over a machine-level test defect in the reason', () => {
      const result = resolve([part('A1', DOWNTIME, NON_BLOCKING)], UNDER_TEST);
      expect(result.status).toBe(OPERATING_WITH_DEFECTS);
      expect(result.reason).toContain('A1');
    });
  });

  it('supports a customised machine-state contribution table', () => {
    const lenient = new MachineStatusResolver({
      [ACTIVE]: 'NONE',
      [UNDER_MAINTENANCE]: 'DEFECT',
      [DOWNTIME]: 'BLOCKING',
      [UNDER_TEST]: 'NONE',
    });
    expect(lenient.resolve({ machineState: UNDER_MAINTENANCE, parts: [] }).status).toBe(
      OPERATING_WITH_DEFECTS,
    );
    expect(lenient.resolve({ machineState: UNDER_TEST, parts: [] }).status).toBe(OPERATING);
    expect(lenient.describe().machineStateContributions[UNDER_MAINTENANCE]).toBe('DEFECT');
  });

  describe('derived machine status', () => {
    it('equals the system status for a machine without parts', () => {
      for (const state of [ACTIVE, UNDER_MAINTENANCE, DOWNTIME, UNDER_TEST]) {
        expect(resolve([], state).machineStatus).toBe(state);
      }
    });

    it('is the most severe of the system status and the part statuses', () => {
      expect(resolve([part('A1', UNDER_MAINTENANCE, NON_BLOCKING)]).machineStatus).toBe(UNDER_MAINTENANCE);
      expect(resolve([part('A1', UNDER_TEST), part('A2', DOWNTIME)]).machineStatus).toBe(DOWNTIME);
      expect(resolve([part('A1', UNDER_TEST)], UNDER_MAINTENANCE).machineStatus).toBe(UNDER_MAINTENANCE);
      expect(resolve([part('A1', DOWNTIME, BLOCKING)], UNDER_TEST).machineStatus).toBe(DOWNTIME);
    });

    it('ignores deactivated parts', () => {
      expect(resolve([part('A1', DOWNTIME, BLOCKING, false)]).machineStatus).toBe(ACTIVE);
    });

    it('is ACTIVE exactly when the machine is OPERATING', () => {
      const states = [ACTIVE, UNDER_MAINTENANCE, DOWNTIME, UNDER_TEST];
      for (const system of states) {
        for (const partState of states) {
          for (const impact of [BLOCKING, NON_BLOCKING]) {
            const result = resolve(
              [part('A1', partState, partState === ACTIVE ? NON_BLOCKING : impact)],
              system,
            );
            expect(result.machineStatus === ACTIVE).toBe(result.status === OPERATING);
          }
        }
      }
    });
  });
});
