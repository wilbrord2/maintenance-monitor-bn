import request from 'supertest';
import { AuditLog } from '../../src/audit/audit-log.entity';
import { MachineState } from '../../src/common/enums/machine-state.enum';
import {
  MAINTENANCE_COMPLETED,
  MAINTENANCE_REMINDER,
  type MaintenanceCompletedEvent,
  type MaintenanceReminderEvent,
} from '../../src/common/events/domain-events';
import { MaintenanceNotification } from '../../src/maintenance/maintenance-notification.entity';
import { MaintenanceSchedule } from '../../src/maintenance/maintenance-schedule.entity';
import {
  adminSession,
  createMachine,
  createPart,
  createSchedule,
  machineOperationalStatus,
  machineStatus,
  machineSystemStatus,
  technicianSession,
  type Session,
} from '../helpers/factories';
import { createTestContext, resetDatabase, type TestContext } from '../helpers/test-app';

const DAY = 86_400_000;
const daysFromNow = (days: number) => new Date(Date.now() + days * DAY);
const dayOf = (iso: string) => iso.slice(0, 10);

describe('Recurring preventive maintenance', () => {
  let ctx: TestContext;
  let admin: Session;
  let tech: Session;
  let machineId: number;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.container.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.container);
    admin = await adminSession(ctx);
    tech = await technicianSession(ctx);
    machineId = (await createMachine(ctx, { name: 'Press 1', serialNumber: 'PRS-200' })).id;
  });

  const schedulesUrl = (id = machineId) => `/api/v1/machines/${id}/maintenance-schedules`;
  const scheduleUrl = (id: number) => `/api/v1/maintenance-schedules/${id}`;

  describe('schedule setup', () => {
    it('derives the first due date from the existing maintenance history', async () => {
      // Last maintained 10 days ago, 20-day interval → due in 10 days (not 20).
      const res = await request(ctx.app)
        .post(schedulesUrl())
        .set(admin.auth)
        .send({
          taskName: 'General maintenance',
          intervalDays: 20,
          reminderDaysBefore: 5,
          lastMaintenanceAt: daysFromNow(-10).toISOString(),
        })
        .expect(201);

      expect(res.body.data).toMatchObject({
        machineId,
        machine: { id: machineId, name: 'Press 1' },
        machinePartId: null,
        machinePart: null,
        taskName: 'General maintenance',
        intervalDays: 20,
        reminderDaysBefore: 5,
        state: 'UPCOMING',
        daysUntilDue: 10,
        isActive: true,
      });
      expect(dayOf(res.body.data.nextMaintenanceAt)).toBe(dayOf(daysFromNow(10).toISOString()));

      const audit = await ctx.container.dataSource
        .getRepository(AuditLog)
        .findOneByOrFail({ action: 'MAINTENANCE_SCHEDULE_CREATED' });
      expect(audit.entity).toBe('MAINTENANCE_SCHEDULE');
    });

    it('starts one interval from today for a task without history', async () => {
      const res = await request(ctx.app)
        .post(schedulesUrl())
        .set(admin.auth)
        .send({ taskName: 'Internal cleaning', intervalDays: 7 })
        .expect(201);
      expect(dayOf(res.body.data.nextMaintenanceAt)).toBe(dayOf(daysFromNow(7).toISOString()));
      expect(res.body.data).toMatchObject({ lastMaintenanceAt: null, reminderDaysBefore: 3 });
    });

    it('gives each part its own task and frequency, alongside machine-wide tasks', async () => {
      const head = await createPart(ctx, machineId, { name: 'Cutting head' });
      const generator = await createPart(ctx, machineId, { name: 'Laser generator' });

      const weekly = await request(ctx.app)
        .post(schedulesUrl())
        .set(admin.auth)
        .send({ machinePartId: head.id, intervalDays: 7 })
        .expect(201);
      expect(weekly.body.data).toMatchObject({
        machinePartId: head.id,
        machinePart: { id: head.id, name: 'Cutting head', partCode: head.partCode },
        taskName: 'Cutting head',
        intervalDays: 7,
      });
      await request(ctx.app)
        .post(schedulesUrl())
        .set(admin.auth)
        .send({ machinePartId: generator.id, intervalDays: 30 })
        .expect(201);
      const daily = await request(ctx.app)
        .post(schedulesUrl())
        .set(admin.auth)
        .send({ taskName: 'External cleaning', intervalDays: 1 })
        .expect(201);
      expect(daily.body.data).toMatchObject({ machinePartId: null, reminderDaysBefore: 0 });

      const all = await request(ctx.app).get(schedulesUrl()).set(tech.auth).expect(200);
      expect(all.body.data.map((s: { taskName: string }) => s.taskName)).toEqual([
        'External cleaning',
        'Cutting head',
        'Laser generator',
      ]);
      const parts = await request(ctx.app).get(`${schedulesUrl()}?scope=part`).set(tech.auth).expect(200);
      expect(parts.body.data).toHaveLength(2);
      const one = await request(ctx.app)
        .get(`${schedulesUrl()}?machinePartId=${generator.id}`)
        .set(tech.auth)
        .expect(200);
      expect(one.body.data).toMatchObject([{ machinePartId: generator.id, intervalDays: 30 }]);

      // The part and machine responses carry the next maintenance of each part.
      const part = await request(ctx.app)
        .get(`/api/v1/machines/${machineId}/parts/${head.id}`)
        .set(tech.auth)
        .expect(200);
      expect(part.body.data.nextMaintenance).toMatchObject({
        scheduleId: weekly.body.data.id,
        taskName: 'Cutting head',
        intervalDays: 7,
        state: 'UPCOMING',
        daysUntilDue: 7,
      });
      const detail = await request(ctx.app).get(`/api/v1/machines/${machineId}`).set(tech.auth).expect(200);
      expect(detail.body.data.maintenanceSchedules).toHaveLength(3);
      expect(
        detail.body.data.partDetails.find((p: { id: number }) => p.id === generator.id).nextMaintenance,
      ).toMatchObject({ intervalDays: 30 });
    });

    it('refuses duplicate tasks, foreign or inactive parts, and unnamed machine-wide tasks', async () => {
      const head = await createPart(ctx, machineId, { name: 'Cutting head' });
      await request(ctx.app)
        .post(schedulesUrl())
        .set(admin.auth)
        .send({ machinePartId: head.id, intervalDays: 7 })
        .expect(201);
      const duplicate = await request(ctx.app)
        .post(schedulesUrl())
        .set(admin.auth)
        .send({ machinePartId: head.id, taskName: 'Cutting head', intervalDays: 30 })
        .expect(409);
      expect(duplicate.body.code).toBe('MAINTENANCE_SCHEDULE_EXISTS');
      // The same task name is fine for another part, or for the machine itself.
      const other = await createPart(ctx, machineId, { name: 'Nozzle' });
      await request(ctx.app)
        .post(schedulesUrl())
        .set(admin.auth)
        .send({ machinePartId: other.id, taskName: 'Cutting head', intervalDays: 7 })
        .expect(201);
      await request(ctx.app)
        .post(schedulesUrl())
        .set(admin.auth)
        .send({ taskName: 'Cutting head', intervalDays: 7 })
        .expect(201);

      const otherMachine = await createMachine(ctx);
      const foreign = await request(ctx.app)
        .post(schedulesUrl(otherMachine.id))
        .set(admin.auth)
        .send({ machinePartId: head.id, intervalDays: 7 })
        .expect(404);
      expect(foreign.body.code).toBe('MACHINE_PART_NOT_FOUND');

      const inactive = await createPart(ctx, machineId, { isActive: false });
      const refused = await request(ctx.app)
        .post(schedulesUrl())
        .set(admin.auth)
        .send({ machinePartId: inactive.id, intervalDays: 7 })
        .expect(422);
      expect(refused.body.code).toBe('MACHINE_PART_INACTIVE');

      await request(ctx.app).post(schedulesUrl()).set(admin.auth).send({ intervalDays: 7 }).expect(400);
      await request(ctx.app)
        .post(schedulesUrl())
        .set(admin.auth)
        .send({ taskName: 'X', intervalDays: 0 })
        .expect(400);
      await request(ctx.app)
        .post(schedulesUrl())
        .set(admin.auth)
        .send({ taskName: 'X', intervalDays: 10, reminderDaysBefore: 20 })
        .expect(400);
    });

    it('recalculates the due date when the interval or history changes', async () => {
      const schedule = await createSchedule(ctx, machineId, {
        intervalDays: 20,
        lastMaintenanceAt: daysFromNow(-10),
        nextMaintenanceAt: daysFromNow(10),
      });
      const res = await request(ctx.app)
        .patch(scheduleUrl(schedule.id))
        .set(admin.auth)
        .send({ intervalDays: 30 })
        .expect(200);
      expect(dayOf(res.body.data.nextMaintenanceAt)).toBe(dayOf(daysFromNow(20).toISOString()));
      expect(res.body.data.daysUntilDue).toBe(20);
    });

    it('changes the reminder window and pauses a schedule without moving the due date', async () => {
      const created = await request(ctx.app)
        .post(schedulesUrl())
        .set(admin.auth)
        .send({ taskName: 'General maintenance', intervalDays: 30, reminderDaysBefore: 3 })
        .expect(201);
      const id = created.body.data.id as number;
      const dueOn = dayOf(created.body.data.nextMaintenanceAt);

      const paused = await request(ctx.app)
        .patch(scheduleUrl(id))
        .set(admin.auth)
        .send({ reminderDaysBefore: 7, isActive: false, description: 'Check oil level' })
        .expect(200);
      expect(paused.body.data).toMatchObject({
        reminderDaysBefore: 7,
        isActive: false,
        description: 'Check oil level',
      });
      expect(dayOf(paused.body.data.nextMaintenanceAt)).toBe(dueOn);

      // An explicit due date wins over recalculation from the history.
      const moved = daysFromNow(12);
      const forced = await request(ctx.app)
        .patch(scheduleUrl(id))
        .set(admin.auth)
        .send({ nextMaintenanceAt: moved.toISOString(), isActive: true })
        .expect(200);
      expect(dayOf(forced.body.data.nextMaintenanceAt)).toBe(dayOf(moved.toISOString()));
      expect(forced.body.data.isActive).toBe(true);

      await request(ctx.app).patch(scheduleUrl(id)).set(admin.auth).send({}).expect(400);
      const missing = await request(ctx.app)
        .patch(scheduleUrl(999999))
        .set(admin.auth)
        .send({ intervalDays: 10 })
        .expect(404);
      expect(missing.body.code).toBe('MAINTENANCE_SCHEDULE_NOT_FOUND');
    });

    it('refuses to rename a task onto an existing one', async () => {
      await createSchedule(ctx, machineId, {
        taskName: 'Oiling',
        intervalDays: 7,
        nextMaintenanceAt: daysFromNow(3),
      });
      const other = await createSchedule(ctx, machineId, {
        taskName: 'Greasing',
        intervalDays: 7,
        nextMaintenanceAt: daysFromNow(3),
      });
      const res = await request(ctx.app)
        .patch(scheduleUrl(other.id))
        .set(admin.auth)
        .send({ taskName: 'Oiling' })
        .expect(409);
      expect(res.body.code).toBe('MAINTENANCE_SCHEDULE_EXISTS');
    });

    it('is readable by technicians but only administrators may change it', async () => {
      const schedule = await createSchedule(ctx, machineId, {
        intervalDays: 15,
        nextMaintenanceAt: daysFromNow(5),
      });
      await request(ctx.app).get(scheduleUrl(schedule.id)).set(tech.auth).expect(200);
      await request(ctx.app).get(schedulesUrl()).set(tech.auth).expect(200);
      await request(ctx.app)
        .post(schedulesUrl())
        .set(tech.auth)
        .send({ taskName: 'X', intervalDays: 10 })
        .expect(403);
      await request(ctx.app)
        .patch(scheduleUrl(schedule.id))
        .set(tech.auth)
        .send({ intervalDays: 10 })
        .expect(403);
    });

    it('reports a missing schedule or machine', async () => {
      const res = await request(ctx.app).get(scheduleUrl(999999)).set(admin.auth).expect(404);
      expect(res.body.code).toBe('MAINTENANCE_SCHEDULE_NOT_FOUND');
      const machine = await request(ctx.app).get(schedulesUrl(999999)).set(admin.auth).expect(404);
      expect(machine.body.code).toBe('MACHINE_NOT_FOUND');
    });

    it('stops the schedules of a part that is deactivated or deleted', async () => {
      const head = await createPart(ctx, machineId, { name: 'Cutting head' });
      const pump = await createPart(ctx, machineId, { name: 'Pump' });
      const headTask = await createSchedule(ctx, machineId, {
        machinePartId: head.id,
        intervalDays: 7,
        nextMaintenanceAt: daysFromNow(3),
      });
      const pumpTask = await createSchedule(ctx, machineId, {
        machinePartId: pump.id,
        intervalDays: 30,
        nextMaintenanceAt: daysFromNow(3),
      });

      await request(ctx.app)
        .patch(`/api/v1/machines/${machineId}/parts/${head.id}`)
        .set(admin.auth)
        .send({ isActive: false })
        .expect(200);
      await request(ctx.app)
        .delete(`/api/v1/machines/${machineId}/parts/${pump.id}`)
        .set(admin.auth)
        .expect(200);

      const repository = ctx.container.dataSource.getRepository(MaintenanceSchedule);
      expect(await repository.findOneByOrFail({ id: headTask.id })).toMatchObject({ isActive: false });
      expect(await repository.findOneByOrFail({ id: pumpTask.id })).toMatchObject({ isActive: false });
    });
  });

  describe('dashboards', () => {
    it('separates upcoming, due and overdue schedules', async () => {
      const dueMachine = await createMachine(ctx, { name: 'Due' });
      const overdueMachine = await createMachine(ctx, { name: 'Overdue' });
      const farMachine = await createMachine(ctx, { name: 'Far away' });
      await createSchedule(ctx, machineId, {
        intervalDays: 15,
        nextMaintenanceAt: daysFromNow(2),
        reminderDaysBefore: 5,
      });
      await createSchedule(ctx, dueMachine.id, { intervalDays: 15, nextMaintenanceAt: new Date() });
      await createSchedule(ctx, overdueMachine.id, { intervalDays: 15, nextMaintenanceAt: daysFromNow(-3) });
      await createSchedule(ctx, farMachine.id, {
        intervalDays: 60,
        nextMaintenanceAt: daysFromNow(40),
        reminderDaysBefore: 5,
      });

      const upcoming = await request(ctx.app).get('/api/v1/maintenance/upcoming').set(tech.auth).expect(200);
      expect(upcoming.body.data.map((s: { machineId: number }) => s.machineId)).toEqual([machineId]);
      expect(upcoming.body.data[0]).toMatchObject({ state: 'UPCOMING', daysUntilDue: 2 });

      const due = await request(ctx.app).get('/api/v1/maintenance/due').set(tech.auth).expect(200);
      expect(due.body.data.map((s: { machineId: number }) => s.machineId)).toEqual([dueMachine.id]);
      expect(due.body.data[0].state).toBe('DUE');

      const overdue = await request(ctx.app).get('/api/v1/maintenance/overdue').set(tech.auth).expect(200);
      expect(overdue.body.data.map((s: { machineId: number }) => s.machineId)).toEqual([overdueMachine.id]);
      expect(overdue.body.data[0]).toMatchObject({ state: 'OVERDUE', daysUntilDue: -3 });
    });

    it('filters dashboards by machine, part and scope', async () => {
      const head = await createPart(ctx, machineId, { name: 'Cutting head' });
      await createSchedule(ctx, machineId, {
        taskName: 'Cleaning',
        intervalDays: 1,
        nextMaintenanceAt: new Date(),
      });
      await createSchedule(ctx, machineId, {
        machinePartId: head.id,
        intervalDays: 7,
        nextMaintenanceAt: new Date(),
      });
      const other = await createMachine(ctx, { name: 'Other' });
      await createSchedule(ctx, other.id, { intervalDays: 7, nextMaintenanceAt: new Date() });

      const due = (query: string) =>
        request(ctx.app).get(`/api/v1/maintenance/due?${query}`).set(tech.auth).expect(200);
      expect((await due('')).body.meta.totalItems).toBe(3);
      expect((await due(`machineId=${machineId}`)).body.meta.totalItems).toBe(2);
      expect((await due(`machinePartId=${head.id}`)).body.data).toMatchObject([
        { machinePart: { id: head.id }, taskName: expect.any(String) },
      ]);
      expect((await due(`machineId=${machineId}&scope=machine`)).body.data).toMatchObject([
        { taskName: 'Cleaning', machinePartId: null },
      ]);
    });
  });

  describe('event lifecycle and machine status', () => {
    let scheduleId: number;

    async function scheduleAndEvent() {
      scheduleId = (
        await createSchedule(ctx, machineId, {
          intervalDays: 20,
          nextMaintenanceAt: daysFromNow(-2),
          lastMaintenanceAt: daysFromNow(-22),
        })
      ).id;
      const created = await request(ctx.app)
        .post('/api/v1/maintenance-events')
        .set(tech.auth)
        .send({ maintenanceScheduleId: scheduleId })
        .expect(201);
      return created.body.data as { id: number; status: string; maintenanceScheduleId: number };
    }

    it('runs the full cycle: start stops the machine, completion releases it and rolls the cycle forward', async () => {
      const completedEvents: MaintenanceCompletedEvent[] = [];
      const off = ctx.container.events.subscribe(MAINTENANCE_COMPLETED, (e) => {
        completedEvents.push(e);
      });
      // A non-blocking part defect remains throughout, so the machine ends OPERATING_WITH_DEFECTS.
      await createPart(ctx, machineId, {
        partCode: 'A2',
        status: MachineState.UNDER_MAINTENANCE,
        isCritical: false,
      });

      try {
        const event = await scheduleAndEvent();
        expect(event.status).toBe('SCHEDULED');

        const started = await request(ctx.app)
          .post(`/api/v1/maintenance-events/${event.id}/start`)
          .set(tech.auth)
          .send({})
          .expect(200);
        expect(started.body.data).toMatchObject({
          status: 'IN_PROGRESS',
          performedBy: { id: tech.user.id },
          machineLogId: expect.any(Number),
        });
        expect(await machineStatus(ctx, machineId)).toBe('UNDER_MAINTENANCE');
        expect(await machineOperationalStatus(ctx, machineId)).toBe('NOT_OPERATING');

        // Completed two days after the scheduled date: the next cycle starts from the completion.
        const completedAt = new Date();
        const completed = await request(ctx.app)
          .post(`/api/v1/maintenance-events/${event.id}/complete`)
          .set(tech.auth)
          .send({ completedAt: completedAt.toISOString(), notes: 'Filters replaced' })
          .expect(200);
        expect(completed.body.data).toMatchObject({ status: 'COMPLETED', notes: 'Filters replaced' });

        const schedule = await ctx.container.dataSource
          .getRepository(MaintenanceSchedule)
          .findOneByOrFail({ id: scheduleId });
        expect(dayOf(schedule.lastMaintenanceAt!.toISOString())).toBe(dayOf(completedAt.toISOString()));
        expect(dayOf(schedule.nextMaintenanceAt.toISOString())).toBe(dayOf(daysFromNow(20).toISOString()));

        // The machine log opened at start was closed: the machine system is ACTIVE again, and
        // the status is re-derived from the parts, so part A2's maintenance still shows.
        expect(await machineSystemStatus(ctx, machineId)).toBe('ACTIVE');
        expect(await machineStatus(ctx, machineId)).toBe('UNDER_MAINTENANCE');
        expect(await machineOperationalStatus(ctx, machineId)).toBe('OPERATING_WITH_DEFECTS');

        expect(completedEvents).toEqual([
          expect.objectContaining({ eventId: event.id, machineId, scheduleId: schedule.id }),
        ]);
        const actions = (await ctx.container.dataSource.getRepository(AuditLog).find()).map((a) => a.action);
        expect(actions).toEqual(
          expect.arrayContaining([
            'MAINTENANCE_EVENT_CREATED',
            'MAINTENANCE_STARTED',
            'MAINTENANCE_COMPLETED',
            'MAINTENANCE_SCHEDULE_UPDATED',
          ]),
        );
      } finally {
        off();
      }
    });

    it('can run maintenance without touching the machine status', async () => {
      const event = await scheduleAndEvent();
      await request(ctx.app)
        .post(`/api/v1/maintenance-events/${event.id}/start`)
        .set(tech.auth)
        .send({ putUnderMaintenance: false })
        .expect(200);
      expect(await machineStatus(ctx, machineId)).toBe('ACTIVE');
      expect(await machineOperationalStatus(ctx, machineId)).toBe('OPERATING');
    });

    it('keeps only one open event per schedule', async () => {
      const event = await scheduleAndEvent();
      const second = await request(ctx.app)
        .post('/api/v1/maintenance-events')
        .set(tech.auth)
        .send({ maintenanceScheduleId: scheduleId })
        .expect(409);
      expect(second.body.code).toBe('MAINTENANCE_EVENT_ALREADY_OPEN');

      await request(ctx.app)
        .post(`/api/v1/maintenance-events/${event.id}/complete`)
        .set(tech.auth)
        .send({})
        .expect(200);
      await request(ctx.app)
        .post('/api/v1/maintenance-events')
        .set(tech.auth)
        .send({ maintenanceScheduleId: scheduleId })
        .expect(201);
    });

    it('runs part maintenance through a part log: the part, and through it the machine, stop and recover', async () => {
      const completedEvents: MaintenanceCompletedEvent[] = [];
      const off = ctx.container.events.subscribe(MAINTENANCE_COMPLETED, (e) => {
        completedEvents.push(e);
      });
      const head = await createPart(ctx, machineId, { name: 'Cutting head', isCritical: true });
      const schedule = await createSchedule(ctx, machineId, {
        machinePartId: head.id,
        taskName: 'Cutting head',
        intervalDays: 7,
        nextMaintenanceAt: daysFromNow(0),
      });
      try {
        const created = await request(ctx.app)
          .post('/api/v1/maintenance-events')
          .set(tech.auth)
          .send({ maintenanceScheduleId: schedule.id })
          .expect(201);
        expect(created.body.data).toMatchObject({
          machinePartId: head.id,
          machinePart: { id: head.id, name: 'Cutting head' },
          taskName: 'Cutting head',
        });
        const id = created.body.data.id as number;

        const started = await request(ctx.app)
          .post(`/api/v1/maintenance-events/${id}/start`)
          .set(tech.auth)
          .send({})
          .expect(200);
        const log = await request(ctx.app)
          .get(`/api/v1/machine-logs/${started.body.data.machineLogId}`)
          .set(tech.auth)
          .expect(200);
        expect(log.body.data).toMatchObject({
          scope: 'PART',
          faultDescription: 'Scheduled preventive maintenance: Cutting head',
        });
        // Critical part under maintenance: the machine system is untouched but cannot operate.
        expect(await machineSystemStatus(ctx, machineId)).toBe('ACTIVE');
        expect(await machineStatus(ctx, machineId)).toBe('UNDER_MAINTENANCE');
        expect(await machineOperationalStatus(ctx, machineId)).toBe('NOT_OPERATING');

        await request(ctx.app)
          .post(`/api/v1/maintenance-events/${id}/complete`)
          .set(tech.auth)
          .send({})
          .expect(200);
        expect(await machineStatus(ctx, machineId)).toBe('ACTIVE');
        expect(await machineOperationalStatus(ctx, machineId)).toBe('OPERATING');
        const part = await request(ctx.app)
          .get(`/api/v1/machines/${machineId}/parts/${head.id}`)
          .set(tech.auth)
          .expect(200);
        expect(part.body.data).toMatchObject({
          status: 'ACTIVE',
          nextMaintenance: { scheduleId: schedule.id, daysUntilDue: 7 },
        });
        expect(completedEvents).toEqual([
          expect.objectContaining({
            machinePartId: head.id,
            partName: 'Cutting head',
            taskName: 'Cutting head',
          }),
        ]);

        const listed = await request(ctx.app)
          .get(`/api/v1/maintenance-events?machinePartId=${head.id}`)
          .set(tech.auth)
          .expect(200);
        expect(listed.body.data.map((e: { id: number }) => e.id)).toEqual([id]);
      } finally {
        off();
      }
    });

    it('rejects invalid lifecycle transitions and future completion times', async () => {
      const event = await scheduleAndEvent();
      await request(ctx.app)
        .post(`/api/v1/maintenance-events/${event.id}/complete`)
        .set(tech.auth)
        .send({ completedAt: daysFromNow(2).toISOString() })
        .expect(422);

      await request(ctx.app)
        .post(`/api/v1/maintenance-events/${event.id}/complete`)
        .set(tech.auth)
        .send({})
        .expect(200);
      const restart = await request(ctx.app)
        .post(`/api/v1/maintenance-events/${event.id}/start`)
        .set(tech.auth)
        .send({})
        .expect(409);
      expect(restart.body.code).toBe('MAINTENANCE_EVENT_STATE_CONFLICT');
    });

    it('lets administrators cancel an event but not technicians', async () => {
      const event = await scheduleAndEvent();
      await request(ctx.app)
        .post(`/api/v1/maintenance-events/${event.id}/cancel`)
        .set(tech.auth)
        .send({})
        .expect(403);
      const cancelled = await request(ctx.app)
        .post(`/api/v1/maintenance-events/${event.id}/cancel`)
        .set(admin.auth)
        .send({ reason: 'Machine retired' })
        .expect(200);
      expect(cancelled.body.data).toMatchObject({ status: 'CANCELLED', notes: 'Machine retired' });
    });

    it('lists and filters events', async () => {
      const event = await scheduleAndEvent();
      await request(ctx.app)
        .post(`/api/v1/maintenance-events/${event.id}/start`)
        .set(tech.auth)
        .send({ putUnderMaintenance: false })
        .expect(200);

      const inProgress = await request(ctx.app)
        .get('/api/v1/maintenance-events?status=IN_PROGRESS')
        .set(tech.auth)
        .expect(200);
      expect(inProgress.body.meta.totalItems).toBe(1);

      const byMachine = await request(ctx.app)
        .get(`/api/v1/maintenance-events?machineId=${machineId}&performedById=${tech.user.id}`)
        .set(tech.auth)
        .expect(200);
      expect(byMachine.body.data[0]).toMatchObject({ id: event.id, machine: { id: machineId } });
      await request(ctx.app).get('/api/v1/maintenance-events?status=NOPE').set(tech.auth).expect(400);

      const byScheduleAndRange = await request(ctx.app)
        .get(
          `/api/v1/maintenance-events?maintenanceScheduleId=${event.maintenanceScheduleId}` +
            `&from=${dayOf(daysFromNow(-5).toISOString())}&to=${dayOf(daysFromNow(5).toISOString())}`,
        )
        .set(tech.auth)
        .expect(200);
      expect(byScheduleAndRange.body.meta.totalItems).toBe(1);

      const outOfRange = await request(ctx.app)
        .get(`/api/v1/maintenance-events?from=${dayOf(daysFromNow(1).toISOString())}`)
        .set(tech.auth)
        .expect(200);
      expect(outOfRange.body.meta.totalItems).toBe(0);
    });

    it('reads and reschedules a single event, and reports unknown ids', async () => {
      const event = await scheduleAndEvent();

      const read = await request(ctx.app)
        .get(`/api/v1/maintenance-events/${event.id}`)
        .set(tech.auth)
        .expect(200);
      expect(read.body.data).toMatchObject({ id: event.id, status: 'SCHEDULED' });

      const newDate = daysFromNow(4);
      const rescheduled = await request(ctx.app)
        .patch(`/api/v1/maintenance-events/${event.id}`)
        .set(admin.auth)
        .send({ scheduledFor: newDate.toISOString(), notes: 'Moved to Friday' })
        .expect(200);
      expect(rescheduled.body.data).toMatchObject({ notes: 'Moved to Friday' });
      expect(dayOf(rescheduled.body.data.scheduledFor)).toBe(dayOf(newDate.toISOString()));

      // Clearing the notes is a real change even though the diff is a removal.
      const cleared = await request(ctx.app)
        .patch(`/api/v1/maintenance-events/${event.id}`)
        .set(admin.auth)
        .send({ notes: null })
        .expect(200);
      expect(cleared.body.data.notes).toBeNull();

      await request(ctx.app)
        .patch(`/api/v1/maintenance-events/${event.id}`)
        .set(admin.auth)
        .send({})
        .expect(400);

      const missingRead = await request(ctx.app)
        .get('/api/v1/maintenance-events/999999')
        .set(tech.auth)
        .expect(404);
      expect(missingRead.body.code).toBe('MAINTENANCE_EVENT_NOT_FOUND');
      const missingPatch = await request(ctx.app)
        .patch('/api/v1/maintenance-events/999999')
        .set(admin.auth)
        .send({ notes: 'x' })
        .expect(404);
      expect(missingPatch.body.code).toBe('MAINTENANCE_EVENT_NOT_FOUND');
    });

    it('refuses to record maintenance for a deactivated machine', async () => {
      const retired = await createMachine(ctx, { isActive: false });
      const res = await request(ctx.app)
        .post('/api/v1/maintenance-events')
        .set(tech.auth)
        .send({ machineId: retired.id })
        .expect(422);
      expect(res.body.code).toBe('MACHINE_INACTIVE');

      const unknown = await request(ctx.app)
        .post('/api/v1/maintenance-events')
        .set(tech.auth)
        .send({ machineId: 999999 })
        .expect(404);
      expect(unknown.body.code).toBe('MACHINE_NOT_FOUND');
    });

    it('records an ad-hoc event with an explicit date for a machine without a schedule', async () => {
      const scheduledFor = daysFromNow(1);
      const res = await request(ctx.app)
        .post('/api/v1/maintenance-events')
        .set(tech.auth)
        .send({ machineId, scheduledFor: scheduledFor.toISOString(), notes: 'Ad-hoc inspection' })
        .expect(201);
      expect(res.body.data).toMatchObject({
        maintenanceScheduleId: null,
        taskName: null,
        machinePartId: null,
        notes: 'Ad-hoc inspection',
        status: 'SCHEDULED',
      });
      expect(dayOf(res.body.data.scheduledFor)).toBe(dayOf(scheduledFor.toISOString()));
    });

    it('records a one-off event for a part, and validates the request shape', async () => {
      const head = await createPart(ctx, machineId, { name: 'Cutting head' });
      const res = await request(ctx.app)
        .post('/api/v1/maintenance-events')
        .set(tech.auth)
        .send({ machineId, machinePartId: head.id })
        .expect(201);
      expect(res.body.data).toMatchObject({ maintenanceScheduleId: null, machinePartId: head.id });

      await request(ctx.app).post('/api/v1/maintenance-events').set(tech.auth).send({}).expect(400);
      const schedule = await createSchedule(ctx, machineId, {
        intervalDays: 7,
        nextMaintenanceAt: daysFromNow(1),
      });
      await request(ctx.app)
        .post('/api/v1/maintenance-events')
        .set(tech.auth)
        .send({ maintenanceScheduleId: schedule.id, machineId })
        .expect(400);
      const missing = await request(ctx.app)
        .post('/api/v1/maintenance-events')
        .set(tech.auth)
        .send({ maintenanceScheduleId: 999999 })
        .expect(404);
      expect(missing.body.code).toBe('MAINTENANCE_SCHEDULE_NOT_FOUND');
    });
  });

  describe('reminder job', () => {
    it('notifies everyone once per cycle, for upcoming, due and overdue schedules', async () => {
      const reminders: MaintenanceReminderEvent[] = [];
      const off = ctx.container.events.subscribe(MAINTENANCE_REMINDER, (e) => {
        reminders.push(e);
      });
      try {
        await createSchedule(ctx, machineId, {
          intervalDays: 15,
          nextMaintenanceAt: new Date(),
          reminderDaysBefore: 3,
        });
        const soon = await createMachine(ctx, { name: 'Soon' });
        await createSchedule(ctx, soon.id, {
          intervalDays: 15,
          nextMaintenanceAt: daysFromNow(2),
          reminderDaysBefore: 3,
        });
        const far = await createMachine(ctx, { name: 'Far' });
        await createSchedule(ctx, far.id, {
          intervalDays: 60,
          nextMaintenanceAt: daysFromNow(30),
          reminderDaysBefore: 3,
        });
        ctx.mail.clear();

        const first = await ctx.container.maintenanceScheduler.run();
        expect(first).toMatchObject({ examined: 3, remindersSent: 2 });
        expect(reminders.map((r) => r.state).sort()).toEqual(['DUE', 'UPCOMING']);
        // One digest per user (admin + technician) covering both schedules.
        expect(ctx.mail.sent).toHaveLength(2);
        expect(ctx.mail.sent[0]!.subject).toBe('Maintenance: 1 due today, 1 upcoming');

        // Running again in the same cycle notifies nobody.
        ctx.mail.clear();
        const second = await ctx.container.maintenanceScheduler.run();
        expect(second.remindersSent).toBe(0);
        expect(ctx.mail.sent).toHaveLength(0);

        const notifications = await ctx.container.dataSource.getRepository(MaintenanceNotification).find();
        expect(notifications).toHaveLength(2);
        expect(notifications.map((n) => n.kind).sort()).toEqual(['DUE', 'UPCOMING']);
        expect(
          await ctx.container.dataSource
            .getRepository(AuditLog)
            .countBy({ action: 'MAINTENANCE_REMINDER_SENT' }),
        ).toBe(2);
      } finally {
        off();
      }
    });

    it('sends a separate overdue reminder and a new reminder for the next cycle', async () => {
      const schedule = await createSchedule(ctx, machineId, {
        intervalDays: 15,
        nextMaintenanceAt: daysFromNow(-1),
        reminderDaysBefore: 3,
      });
      await ctx.container.maintenanceScheduler.run();
      let kinds = (await ctx.container.dataSource.getRepository(MaintenanceNotification).find()).map(
        (n) => n.kind,
      );
      expect(kinds).toEqual(['OVERDUE']);

      // The cycle moves on (maintenance performed): a new due date means a new reminder.
      await ctx.container.dataSource
        .getRepository(MaintenanceSchedule)
        .update({ id: schedule.id }, { nextMaintenanceAt: new Date(), lastMaintenanceAt: daysFromNow(-15) });
      const run = await ctx.container.maintenanceScheduler.run();
      expect(run.remindersSent).toBe(1);
      kinds = (await ctx.container.dataSource.getRepository(MaintenanceNotification).find()).map(
        (n) => n.kind,
      );
      expect(kinds.sort()).toEqual(['DUE', 'OVERDUE']);
    });

    it('ignores inactive schedules', async () => {
      await createSchedule(ctx, machineId, {
        intervalDays: 15,
        nextMaintenanceAt: new Date(),
        isActive: false,
      });
      expect(await ctx.container.maintenanceScheduler.run()).toMatchObject({
        examined: 0,
        remindersSent: 0,
      });
    });
  });

  it('keeps maintenance state independent of machine operational status', async () => {
    const critical = await createPart(ctx, machineId, { partCode: 'A1', isCritical: true });
    await request(ctx.app)
      .post('/api/v1/machine-logs')
      .set(tech.auth)
      .send({ machineId, machinePartId: critical.id, resultingState: 'DOWNTIME', faultDescription: 'Seized' })
      .expect(201);
    await createSchedule(ctx, machineId, { intervalDays: 30, nextMaintenanceAt: daysFromNow(25) });
    await createSchedule(ctx, machineId, {
      machinePartId: critical.id,
      intervalDays: 7,
      nextMaintenanceAt: daysFromNow(5),
    });

    const detail = await request(ctx.app).get(`/api/v1/machines/${machineId}`).set(admin.auth).expect(200);
    expect(detail.body.data).toMatchObject({
      status: 'DOWNTIME',
      systemStatus: 'ACTIVE',
      operationalStatus: 'NOT_OPERATING',
      maintenanceSchedules: [
        { machinePartId: null, state: 'UPCOMING', daysUntilDue: 25 },
        { machinePartId: critical.id, state: 'UPCOMING', daysUntilDue: 5 },
      ],
    });
  });

  it('reports maintenance compliance in analytics', async () => {
    const schedule = await createSchedule(ctx, machineId, {
      intervalDays: 20,
      nextMaintenanceAt: daysFromNow(-1),
    });
    const event = await request(ctx.app)
      .post('/api/v1/maintenance-events')
      .set(tech.auth)
      .send({ maintenanceScheduleId: schedule.id })
      .expect(201);
    await request(ctx.app)
      .post(`/api/v1/maintenance-events/${event.body.data.id}/complete`)
      .set(tech.auth)
      .send({})
      .expect(200);

    const res = await request(ctx.app).get('/api/v1/analytics/maintenance').set(tech.auth).expect(200);
    expect(res.body.data).toMatchObject({
      schedules: { total: 1, active: 1, upcoming: 1 },
      compliance: { completed: 1, missed: 0 },
    });
    expect(res.body.data.byMachine[0]).toMatchObject({ machine: { id: machineId }, completed: 1 });
  });
});
