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

  const scheduleUrl = (id = machineId) => `/api/v1/machines/${id}/maintenance`;

  describe('schedule setup', () => {
    it('derives the first due date from the existing maintenance history', async () => {
      // Last maintained 10 days ago, 20-day interval → due in 10 days (not 20).
      const res = await request(ctx.app)
        .post(scheduleUrl())
        .set(admin.auth)
        .send({
          intervalDays: 20,
          reminderDaysBefore: 5,
          lastMaintenanceAt: daysFromNow(-10).toISOString(),
        })
        .expect(201);

      expect(res.body.data).toMatchObject({
        machineId,
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

    it('starts one interval from today for a machine without history', async () => {
      const res = await request(ctx.app)
        .post(scheduleUrl())
        .set(admin.auth)
        .send({ intervalDays: 15 })
        .expect(201);
      expect(dayOf(res.body.data.nextMaintenanceAt)).toBe(dayOf(daysFromNow(15).toISOString()));
      expect(res.body.data.lastMaintenanceAt).toBeNull();
    });

    it('allows one schedule per machine and validates the interval', async () => {
      await request(ctx.app).post(scheduleUrl()).set(admin.auth).send({ intervalDays: 15 }).expect(201);
      const duplicate = await request(ctx.app)
        .post(scheduleUrl())
        .set(admin.auth)
        .send({ intervalDays: 30 })
        .expect(409);
      expect(duplicate.body.code).toBe('MAINTENANCE_SCHEDULE_EXISTS');

      const other = await createMachine(ctx);
      await request(ctx.app)
        .post(scheduleUrl(other.id))
        .set(admin.auth)
        .send({ intervalDays: 0 })
        .expect(400);
      await request(ctx.app)
        .post(scheduleUrl(other.id))
        .set(admin.auth)
        .send({ intervalDays: 10, reminderDaysBefore: 20 })
        .expect(400);
    });

    it('recalculates the due date when the interval or history changes', async () => {
      await createSchedule(ctx, machineId, {
        intervalDays: 20,
        lastMaintenanceAt: daysFromNow(-10),
        nextMaintenanceAt: daysFromNow(10),
      });
      const res = await request(ctx.app)
        .patch(scheduleUrl())
        .set(admin.auth)
        .send({ intervalDays: 30 })
        .expect(200);
      expect(dayOf(res.body.data.nextMaintenanceAt)).toBe(dayOf(daysFromNow(20).toISOString()));
      expect(res.body.data.daysUntilDue).toBe(20);
    });

    it('changes the reminder window and pauses a schedule without moving the due date', async () => {
      const created = await request(ctx.app)
        .post(scheduleUrl())
        .set(admin.auth)
        .send({ intervalDays: 30, reminderDaysBefore: 3 })
        .expect(201);
      const dueOn = dayOf(created.body.data.nextMaintenanceAt);

      const paused = await request(ctx.app)
        .patch(scheduleUrl())
        .set(admin.auth)
        .send({ reminderDaysBefore: 7, isActive: false })
        .expect(200);
      expect(paused.body.data).toMatchObject({ reminderDaysBefore: 7, isActive: false });
      expect(dayOf(paused.body.data.nextMaintenanceAt)).toBe(dueOn);

      // An explicit due date wins over recalculation from the history.
      const moved = daysFromNow(12);
      const forced = await request(ctx.app)
        .patch(scheduleUrl())
        .set(admin.auth)
        .send({ nextMaintenanceAt: moved.toISOString(), isActive: true })
        .expect(200);
      expect(dayOf(forced.body.data.nextMaintenanceAt)).toBe(dayOf(moved.toISOString()));
      expect(forced.body.data.isActive).toBe(true);

      await request(ctx.app).patch(scheduleUrl()).set(admin.auth).send({}).expect(400);
      const missing = await request(ctx.app)
        .patch(scheduleUrl(999999))
        .set(admin.auth)
        .send({ intervalDays: 10 })
        .expect(404);
      expect(missing.body.code).toBe('MACHINE_NOT_FOUND');
    });

    it('is readable by technicians but only administrators may change it', async () => {
      await createSchedule(ctx, machineId, { intervalDays: 15, nextMaintenanceAt: daysFromNow(5) });
      await request(ctx.app).get(scheduleUrl()).set(tech.auth).expect(200);
      await request(ctx.app).post(scheduleUrl()).set(tech.auth).send({ intervalDays: 10 }).expect(403);
      await request(ctx.app).patch(scheduleUrl()).set(tech.auth).send({ intervalDays: 10 }).expect(403);
    });

    it('reports a missing schedule', async () => {
      const res = await request(ctx.app).get(scheduleUrl()).set(admin.auth).expect(404);
      expect(res.body.code).toBe('MAINTENANCE_SCHEDULE_NOT_FOUND');
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
  });

  describe('event lifecycle and machine status', () => {
    async function scheduleAndEvent() {
      await createSchedule(ctx, machineId, {
        intervalDays: 20,
        nextMaintenanceAt: daysFromNow(-2),
        lastMaintenanceAt: daysFromNow(-22),
      });
      const created = await request(ctx.app)
        .post('/api/v1/maintenance-events')
        .set(tech.auth)
        .send({ machineId })
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
          .findOneByOrFail({ machineId });
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
        .send({ putMachineUnderMaintenance: false })
        .expect(200);
      expect(await machineStatus(ctx, machineId)).toBe('ACTIVE');
      expect(await machineOperationalStatus(ctx, machineId)).toBe('OPERATING');
    });

    it('keeps only one open event per schedule', async () => {
      const event = await scheduleAndEvent();
      const second = await request(ctx.app)
        .post('/api/v1/maintenance-events')
        .set(tech.auth)
        .send({ machineId })
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
        .send({ machineId })
        .expect(201);
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
        .send({ putMachineUnderMaintenance: false })
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
        notes: 'Ad-hoc inspection',
        status: 'SCHEDULED',
      });
      expect(dayOf(res.body.data.scheduledFor)).toBe(dayOf(scheduledFor.toISOString()));
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
        // Two users (admin + technician) × two schedules.
        expect(ctx.mail.sent).toHaveLength(4);
        expect(ctx.mail.sent[0]!.subject).toMatch(/Maintenance due/);

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

    const detail = await request(ctx.app).get(`/api/v1/machines/${machineId}`).set(admin.auth).expect(200);
    expect(detail.body.data).toMatchObject({
      status: 'DOWNTIME',
      systemStatus: 'ACTIVE',
      operationalStatus: 'NOT_OPERATING',
      maintenance: { state: 'UPCOMING', daysUntilDue: 25 },
    });
  });

  it('reports maintenance compliance in analytics', async () => {
    await createSchedule(ctx, machineId, { intervalDays: 20, nextMaintenanceAt: daysFromNow(-1) });
    const event = await request(ctx.app)
      .post('/api/v1/maintenance-events')
      .set(tech.auth)
      .send({ machineId })
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
