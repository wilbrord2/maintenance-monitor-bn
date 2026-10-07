import { IsNull } from 'typeorm';
import { seedInspectionSchedule } from '../../src/database/seeds/inspection-schedule.seed';
import { inspectionMachines } from '../../src/database/seeds/inspection-schedule.data';
import { MachinePart } from '../../src/machine-parts/machine-part.entity';
import { Machine } from '../../src/machines/machine.entity';
import { MaintenanceSchedule } from '../../src/maintenance/maintenance-schedule.entity';
import { createMachine, createPart, createSchedule } from '../helpers/factories';
import { createTestContext, resetDatabase, type TestContext } from '../helpers/test-app';

const NOW = new Date('2026-10-07T08:00:00Z');

describe('Inspection schedule seed', () => {
  let ctx: TestContext;
  const expected = inspectionMachines();
  const partCount = expected.reduce((sum, machine) => sum + machine.parts.length, 0);
  const scheduleCount = expected.reduce(
    (sum, machine) => sum + machine.parts.length + machine.machineTasks.length,
    0,
  );

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.container.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.container);
  });

  it('creates every machine, part and schedule, and changes nothing when run again', async () => {
    const first = await seedInspectionSchedule(ctx.container.dataSource, NOW);
    expect(first).toEqual({
      machines: { created: expected.length, existing: 0 },
      parts: { created: partCount, existing: 0 },
      schedules: { created: scheduleCount, existing: 0 },
    });

    const second = await seedInspectionSchedule(ctx.container.dataSource, new Date('2026-12-01T00:00:00Z'));
    expect(second).toEqual({
      machines: { created: 0, existing: expected.length },
      parts: { created: 0, existing: partCount },
      schedules: { created: 0, existing: scheduleCount },
    });

    const machine = await ctx.container.dataSource
      .getRepository(Machine)
      .findOneByOrFail({ name: 'Laser Cutting System 1 - CNC Laser Cutting Machine' });
    expect(machine.serialNumber).toBe('INSP-01-01');
    const schedules = await ctx.container.dataSource
      .getRepository(MaintenanceSchedule)
      .find({ where: { machineId: machine.id }, relations: { machinePart: true } });
    expect(schedules.filter((s) => s.machinePartId !== null)).toHaveLength(11);
    expect(
      schedules
        .filter((s) => s.machinePartId === null)
        .map((s) => s.taskName)
        .sort(),
    ).toEqual(['External cleaning', 'Internal cleaning']);
    // Due dates were set by the first run and kept by the second.
    const cuttingHead = schedules.find((s) => s.machinePart?.name === 'Cutting head');
    expect(cuttingHead).toMatchObject({ intervalDays: 7, reminderDaysBefore: 3 });
    expect(cuttingHead!.nextMaintenanceAt.toISOString()).toBe('2026-10-14T08:00:00.000Z');
    const cleaning = schedules.find((s) => s.taskName === 'External cleaning');
    expect(cleaning).toMatchObject({ intervalDays: 1, reminderDaysBefore: 0 });
  });

  it('reuses existing machines, parts and schedules without overwriting them', async () => {
    const lathe = await createMachine(ctx, { name: 'lathe machine', serialNumber: 'LATHE-1' });
    const press = await createMachine(ctx, { name: 'Four Column Hydraulic Press 1', serialNumber: 'FCP-1' });
    const pump = await createPart(ctx, press.id, { name: 'PUMP', partCode: 'P01' });
    const pumpTask = await createSchedule(ctx, press.id, {
      machinePartId: pump.id,
      taskName: 'Pump',
      intervalDays: 14,
      nextMaintenanceAt: new Date('2026-10-20T00:00:00Z'),
    });

    const result = await seedInspectionSchedule(ctx.container.dataSource, NOW);
    expect(result.machines).toEqual({ created: expected.length - 2, existing: 2 });
    expect(result.parts.existing).toBe(1);
    expect(result.schedules.existing).toBe(1);

    const machines = ctx.container.dataSource.getRepository(Machine);
    expect(await machines.countBy({ name: 'Lathe Machine' })).toBe(0);
    const latheTasks = await ctx.container.dataSource
      .getRepository(MaintenanceSchedule)
      .findBy({ machineId: lathe.id, machinePartId: IsNull() });
    expect(latheTasks.map((s) => s.taskName).sort()).toEqual([
      'External cleaning',
      'General inspection',
      'Internal cleaning',
    ]);

    // The existing schedule keeps its interval and due date; new parts avoid the code P01 already in use.
    expect(
      await ctx.container.dataSource.getRepository(MaintenanceSchedule).findOneByOrFail({ id: pumpTask.id }),
    ).toMatchObject({ intervalDays: 14, nextMaintenanceAt: new Date('2026-10-20T00:00:00Z') });
    const pressParts = await ctx.container.dataSource
      .getRepository(MachinePart)
      .findBy({ machineId: press.id });
    expect(pressParts).toHaveLength(9);
    expect(new Set(pressParts.map((p) => p.partCode)).size).toBe(9);
  });
});
