import request from 'supertest';
import { LogStatus } from '../../src/common/enums/log-status.enum';
import { MachineState } from '../../src/common/enums/machine-state.enum';
import { MachineLog } from '../../src/machine-logs/machine-log.entity';
import { createMachine, createUser, technicianSession, type Session } from '../helpers/factories';
import { createTestContext, resetDatabase, type TestContext } from '../helpers/test-app';

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

describe('Analytics', () => {
  let ctx: TestContext;
  let tech: Session;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.container.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.container);
    tech = await technicianSession(ctx);
  });

  /** Seeds historical logs directly so that startedAt can be placed in the past. */
  async function seed() {
    const laser = await createMachine(ctx, {
      name: 'Laser 1',
      serialNumber: 'LSR-1',
      status: MachineState.DOWNTIME,
    });
    const press = await createMachine(ctx, {
      name: 'Press 1',
      serialNumber: 'PRS-1',
      status: MachineState.UNDER_MAINTENANCE,
    });
    await createMachine(ctx, { name: 'Chiller 1', serialNumber: 'CHL-1', status: MachineState.ACTIVE });
    await createMachine(ctx, {
      name: 'Old Shear',
      serialNumber: 'SHR-0',
      status: MachineState.DOWNTIME,
      isActive: false,
    });
    const other = await createUser(ctx, { fullName: 'Second Tech' });

    const repository = ctx.container.dataSource.getRepository(MachineLog);
    const log = (values: Partial<MachineLog>) =>
      repository.save(
        repository.create({
          userId: tech.user.id,
          entryStatus: MachineState.ACTIVE,
          resultingState: MachineState.ACTIVE,
          logStatus: LogStatus.CLOSED,
          faultDescription: 'Generic fault',
          downtimeHours: 0,
          ...values,
          endedAt:
            values.logStatus === LogStatus.OPEN ? null : (values.endedAt ?? values.startedAt ?? new Date()),
        }),
      );

    await log({ machineId: laser.id, faultDescription: 'Oil leak', startedAt: daysAgo(2), downtimeHours: 4 });
    await log({
      machineId: laser.id,
      faultDescription: '  oil   LEAK ',
      startedAt: daysAgo(10),
      downtimeHours: 6,
    });
    await log({
      machineId: laser.id,
      faultDescription: 'Oil leak',
      startedAt: daysAgo(20),
      downtimeHours: 1.5,
      logStatus: LogStatus.OPEN,
    });
    await log({
      machineId: press.id,
      faultDescription: 'Oil leak',
      startedAt: daysAgo(5),
      downtimeHours: 2,
      userId: other.id,
    });
    await log({
      machineId: press.id,
      faultDescription: 'Sensor fault',
      startedAt: daysAgo(60),
      downtimeHours: 8,
    });
    const deleted = await log({
      machineId: press.id,
      faultDescription: 'Deleted entry',
      startedAt: daysAgo(1),
      downtimeHours: 100,
    });
    await repository.softDelete({ id: deleted.id });
    return { laser, press, other };
  }

  const get = (path: string) => request(ctx.app).get(path).set(tech.auth);

  it('overview reports current machine status and last-30-day log totals', async () => {
    await seed();
    const res = await get('/api/v1/analytics/overview').expect(200);
    expect(res.body.data).toMatchObject({
      range: { days: 30 },
      machines: { total: 4, active: 1, downtime: 1, underMaintenance: 1, underTest: 0, inactive: 1 },
      logs: { total: 4, open: 1, closed: 3, currentlyOpen: 1 },
      totalDowntimeHours: 13.5,
    });
  });

  it('supports days and calendar ranges', async () => {
    await seed();
    const week = await get('/api/v1/analytics/overview?days=7').expect(200);
    expect(week.body.data.logs.total).toBe(2);
    expect(week.body.data.totalDowntimeHours).toBe(6);

    const quarter = await get('/api/v1/analytics/overview?days=90').expect(200);
    expect(quarter.body.data.logs.total).toBe(5);

    const from = daysAgo(11).toISOString().slice(0, 10);
    const to = daysAgo(9).toISOString().slice(0, 10);
    const custom = await get(`/api/v1/analytics/overview?from=${from}&to=${to}`).expect(200);
    expect(custom.body.data.logs.total).toBe(1);
    expect(custom.body.data.range.days).toBe(3);
  });

  it('validates time ranges', async () => {
    const both = await get('/api/v1/analytics/overview?days=7&from=2026-01-01&to=2026-01-02').expect(400);
    expect(both.body.code).toBe('INVALID_TIME_RANGE');
    const halfOpen = await get('/api/v1/analytics/overview?from=2026-01-01').expect(400);
    expect(halfOpen.body.code).toBe('INVALID_TIME_RANGE');
    const inverted = await get('/api/v1/analytics/downtime?from=2026-03-01&to=2026-01-01').expect(400);
    expect(inverted.body.code).toBe('INVALID_TIME_RANGE');
    await get('/api/v1/analytics/overview?days=abc').expect(400);
    await get('/api/v1/analytics/overview?from=2026/01/01&to=2026/01/02').expect(400);
  });

  it('reports downtime by machine', async () => {
    const { laser, press } = await seed();
    const res = await get('/api/v1/analytics/downtime').expect(200);
    expect(res.body.data.totalDowntimeHours).toBe(13.5);
    expect(res.body.data.byMachine).toEqual([
      { machine: { id: laser.id, name: 'Laser 1', serialNumber: 'LSR-1' }, downtimeHours: 11.5, events: 3 },
      { machine: { id: press.id, name: 'Press 1', serialNumber: 'PRS-1' }, downtimeHours: 2, events: 1 },
    ]);
  });

  it('reports maintenance events by machine', async () => {
    const { laser } = await seed();
    const res = await get('/api/v1/analytics/maintenance-events?limit=1').expect(200);
    expect(res.body.data.totals).toEqual({ total: 4, open: 1, closed: 3 });
    expect(res.body.data.byMachine).toEqual([
      { machine: expect.objectContaining({ id: laser.id }), totalEvents: 3, openEvents: 1, closedEvents: 2 },
    ]);
  });

  it('reports logs by technician', async () => {
    const { other } = await seed();
    const res = await get('/api/v1/analytics/technicians').expect(200);
    expect(res.body.data.byTechnician).toEqual([
      expect.objectContaining({
        technician: expect.objectContaining({ id: tech.user.id }),
        totalLogs: 3,
        openLogs: 1,
        closedLogs: 2,
        downtimeHours: 11.5,
      }),
      expect.objectContaining({
        technician: expect.objectContaining({ id: other.id, fullName: 'Second Tech' }),
        totalLogs: 1,
      }),
    ]);
  });

  it('groups common faults and detects recurring issues per machine', async () => {
    const { laser } = await seed();
    const res = await get('/api/v1/analytics/faults').expect(200);
    expect(res.body.data.commonFaults[0]).toEqual(
      expect.objectContaining({ fault: 'oil leak', occurrences: 4, machinesAffected: 2 }),
    );
    expect(res.body.data.recurringIssues).toEqual([
      expect.objectContaining({
        machine: expect.objectContaining({ id: laser.id }),
        fault: 'oil leak',
        occurrences: 3,
      }),
    ]);

    const strict = await get('/api/v1/analytics/faults?minOccurrences=4').expect(200);
    expect(strict.body.data.recurringIssues).toEqual([]);
  });

  it('is available to technicians and requires authentication', async () => {
    await request(ctx.app).get('/api/v1/analytics/overview').expect(401);
    await get('/api/v1/analytics/overview').expect(200);
  });
});
