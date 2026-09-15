import request from 'supertest';
import { AuditLog } from '../../src/audit/audit-log.entity';
import { MachineState } from '../../src/common/enums/machine-state.enum';
import {
  MACHINE_STATUS_UPDATED,
  type MachineStatusUpdatedEvent,
} from '../../src/common/events/domain-events';
import { MachineLog } from '../../src/machine-logs/machine-log.entity';
import {
  adminSession,
  createMachine,
  expectStatusMatchesLatestLog,
  machineStatus,
  technicianSession,
  type Session,
} from '../helpers/factories';
import { createTestContext, resetDatabase, type TestContext } from '../helpers/test-app';

describe('Machine logs', () => {
  let ctx: TestContext;
  let admin: Session;
  let tech: Session;
  let events: MachineStatusUpdatedEvent[];
  let unsubscribe: () => void;

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
    events = [];
    unsubscribe = ctx.container.events.subscribe(MACHINE_STATUS_UPDATED, (event) => {
      events.push(event);
    });
  });

  afterEach(() => {
    unsubscribe();
  });

  const createLog = (session: Session, body: Record<string, unknown>) =>
    request(ctx.app).post('/api/v1/machine-logs').set(session.auth).send(body);

  const updateLog = (session: Session, id: number, body: Record<string, unknown>) =>
    request(ctx.app).patch(`/api/v1/machine-logs/${id}`).set(session.auth).send(body);

  describe('POST /machine-logs', () => {
    it('records the log, updates machine status, audits and emits machine.status.updated', async () => {
      const machine = await createMachine(ctx, { name: 'Laser 1' });
      const res = await createLog(tech, {
        machineId: machine.id,
        faultDescription: 'Beam misalignment',
        causeDescription: 'Loose mirror mount',
        entryStatus: 'ACTIVE',
        resultingState: 'UNDER_MAINTENANCE',
        nextMaintenancePlan: 'Re-check in 2 weeks',
      }).expect(201);

      expect(res.body).toMatchObject({
        success: true,
        message: 'Machine log created successfully',
        data: {
          machine: { id: machine.id, name: 'Laser 1' },
          technician: { id: tech.user.id, fullName: tech.user.fullName },
          entryStatus: 'ACTIVE',
          resultingState: 'UNDER_MAINTENANCE',
          logStatus: 'OPEN',
          endedAt: null,
          downtimeHours: 0,
          version: 1,
        },
      });
      expect(await machineStatus(ctx, machine.id)).toBe('UNDER_MAINTENANCE');

      const audits = await ctx.container.dataSource.getRepository(AuditLog).find({ order: { id: 'ASC' } });
      const logAudits = audits.filter((a) => a.action.startsWith('MACHINE_'));
      expect(logAudits.map((a) => a.action)).toEqual(['MACHINE_LOG_CREATED', 'MACHINE_STATUS_CHANGED']);
      expect(logAudits[1]).toMatchObject({
        userId: tech.user.id,
        entityId: String(machine.id),
        oldValues: { status: 'ACTIVE' },
        newValues: { status: 'UNDER_MAINTENANCE', logId: res.body.data.id },
      });

      expect(events).toEqual([
        expect.objectContaining({
          machineId: machine.id,
          previousStatus: 'ACTIVE',
          newStatus: 'UNDER_MAINTENANCE',
          updatedBy: { id: tech.user.id, name: tech.user.fullName },
          timestamp: expect.any(String),
        }),
      ]);
    });

    it('rejects a log whose entry status does not match the current machine status', async () => {
      const machine = await createMachine(ctx, { status: MachineState.DOWNTIME });
      const res = await createLog(tech, {
        machineId: machine.id,
        faultDescription: 'Stale view',
        entryStatus: 'ACTIVE',
        resultingState: 'UNDER_TEST',
      }).expect(409);
      expect(res.body.code).toBe('MACHINE_STATE_CONFLICT');
      expect(await machineStatus(ctx, machine.id)).toBe('DOWNTIME');
      expect(await ctx.container.dataSource.getRepository(MachineLog).count()).toBe(0);
      expect(events).toHaveLength(0);
    });

    it('rejects closing an event that leaves the machine down', async () => {
      const machine = await createMachine(ctx);
      const res = await createLog(tech, {
        machineId: machine.id,
        faultDescription: 'Motor failure',
        entryStatus: 'ACTIVE',
        resultingState: 'DOWNTIME',
        logStatus: 'CLOSED',
      }).expect(422);
      expect(res.body.code).toBe('INVALID_LOG_STATUS');
      expect(await machineStatus(ctx, machine.id)).toBe('ACTIVE');
    });

    it('closes a completed event with a default end time and calculated downtime', async () => {
      const machine = await createMachine(ctx, { status: MachineState.DOWNTIME });
      const startedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
      const res = await createLog(tech, {
        machineId: machine.id,
        faultDescription: 'Belt snapped',
        remedyAction: 'Replaced belt',
        entryStatus: 'DOWNTIME',
        resultingState: 'ACTIVE',
        logStatus: 'CLOSED',
        startedAt,
      }).expect(201);
      expect(res.body.data.endedAt).not.toBeNull();
      expect(res.body.data.downtimeHours).toBeCloseTo(3, 1);
      expect(await machineStatus(ctx, machine.id)).toBe('ACTIVE');
    });

    it('validates times and downtime', async () => {
      const machine = await createMachine(ctx);
      const base = {
        machineId: machine.id,
        faultDescription: 'x',
        entryStatus: 'ACTIVE',
        resultingState: 'ACTIVE',
      };

      const negative = await createLog(tech, { ...base, downtimeHours: -2 }).expect(400);
      expect(negative.body.details[0]).toEqual({ field: 'downtimeHours', message: 'cannot be negative' });

      const backwards = await createLog(tech, {
        ...base,
        logStatus: 'CLOSED',
        startedAt: '2026-09-01T10:00:00Z',
        endedAt: '2026-09-01T09:00:00Z',
      }).expect(422);
      expect(backwards.body.code).toBe('INVALID_LOG_TIMES');

      const tooMuch = await createLog(tech, {
        ...base,
        logStatus: 'CLOSED',
        startedAt: '2026-09-01T09:00:00Z',
        endedAt: '2026-09-01T10:00:00Z',
        downtimeHours: 5,
      }).expect(422);
      expect(tooMuch.body.code).toBe('INVALID_DOWNTIME');

      const badEnum = await createLog(tech, { ...base, resultingState: 'EXPLODED' }).expect(400);
      expect(badEnum.body.details[0].field).toBe('resultingState');
    });

    it('rejects unknown and deactivated machines, and ignores client-supplied authorship', async () => {
      const base = { faultDescription: 'x', entryStatus: 'ACTIVE', resultingState: 'DOWNTIME' };
      const missing = await createLog(tech, { ...base, machineId: 999_999 }).expect(404);
      expect(missing.body.code).toBe('MACHINE_NOT_FOUND');

      const inactive = await createMachine(ctx, { isActive: false });
      const res = await createLog(tech, { ...base, machineId: inactive.id }).expect(422);
      expect(res.body.code).toBe('MACHINE_INACTIVE');

      const machine = await createMachine(ctx);
      const spoof = await createLog(tech, { ...base, machineId: machine.id, userId: admin.user.id }).expect(
        400,
      );
      expect(spoof.body.details).toContainEqual({ field: 'userId', message: 'is not allowed' });
    });
  });

  describe('PATCH /machine-logs/:id', () => {
    async function openDowntimeLog() {
      const machine = await createMachine(ctx);
      const res = await createLog(tech, {
        machineId: machine.id,
        faultDescription: 'Compressor overheating',
        entryStatus: 'ACTIVE',
        resultingState: 'DOWNTIME',
        startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      }).expect(201);
      return { machine, log: res.body.data as { id: number; version: number } };
    }

    it('progresses a single event through states and closes it, keeping status in sync', async () => {
      const { machine, log } = await openDowntimeLog();

      const maintenance = await updateLog(tech, log.id, {
        version: 1,
        resultingState: 'UNDER_MAINTENANCE',
        causeDescription: 'Clogged filter',
      }).expect(200);
      expect(maintenance.body.data).toMatchObject({ resultingState: 'UNDER_MAINTENANCE', version: 2 });
      expect(await machineStatus(ctx, machine.id)).toBe('UNDER_MAINTENANCE');

      // Closing while under maintenance is refused…
      const early = await updateLog(tech, log.id, { version: 2, logStatus: 'CLOSED' }).expect(422);
      expect(early.body.code).toBe('INVALID_LOG_STATUS');

      // …but back to ACTIVE and closed in one update is fine; downtime is calculated.
      const closed = await updateLog(tech, log.id, {
        version: 2,
        resultingState: 'ACTIVE',
        logStatus: 'CLOSED',
        remedyAction: 'Replaced filter',
      }).expect(200);
      expect(closed.body.data).toMatchObject({ resultingState: 'ACTIVE', logStatus: 'CLOSED', version: 3 });
      expect(closed.body.data.downtimeHours).toBeCloseTo(2, 1);
      expect(await machineStatus(ctx, machine.id)).toBe('ACTIVE');
      await expectStatusMatchesLatestLog(ctx, machine.id);

      expect(events.map((e) => `${e.previousStatus}->${e.newStatus}`)).toEqual([
        'ACTIVE->DOWNTIME',
        'DOWNTIME->UNDER_MAINTENANCE',
        'UNDER_MAINTENANCE->ACTIVE',
      ]);
    });

    it('re-opening a log clears its end time', async () => {
      const machine = await createMachine(ctx);
      const created = await createLog(tech, {
        machineId: machine.id,
        faultDescription: 'Inspection',
        entryStatus: 'ACTIVE',
        resultingState: 'ACTIVE',
        logStatus: 'CLOSED',
      }).expect(201);
      const reopened = await updateLog(tech, created.body.data.id, { version: 1, logStatus: 'OPEN' }).expect(
        200,
      );
      expect(reopened.body.data).toMatchObject({ logStatus: 'OPEN', endedAt: null });
    });

    it('rejects stale versions (concurrent edits)', async () => {
      const { log } = await openDowntimeLog();
      await updateLog(tech, log.id, { version: 1, remedyAction: 'first' }).expect(200);
      const stale = await updateLog(admin, log.id, { version: 1, remedyAction: 'second' }).expect(409);
      expect(stale.body.code).toBe('STALE_VERSION');
    });

    it("refuses to change a historical log's resulting state but allows closing it", async () => {
      const { machine, log } = await openDowntimeLog();
      await createLog(tech, {
        machineId: machine.id,
        faultDescription: 'Technician arrived',
        entryStatus: 'DOWNTIME',
        resultingState: 'UNDER_MAINTENANCE',
      }).expect(201);

      const immutable = await updateLog(tech, log.id, { version: 1, resultingState: 'ACTIVE' }).expect(409);
      expect(immutable.body.code).toBe('RESULTING_STATE_IMMUTABLE');

      await updateLog(tech, log.id, { version: 1, logStatus: 'CLOSED' }).expect(200);
      expect(await machineStatus(ctx, machine.id)).toBe('UNDER_MAINTENANCE');
      await expectStatusMatchesLatestLog(ctx, machine.id);
    });

    it('does not allow changing immutable fields', async () => {
      const { log } = await openDowntimeLog();
      const other = await createMachine(ctx);
      const res = await updateLog(tech, log.id, {
        version: 1,
        machineId: other.id,
        entryStatus: 'UNDER_TEST',
      }).expect(400);
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          { field: 'machineId', message: 'is not allowed' },
          { field: 'entryStatus', message: 'is not allowed' },
        ]),
      );
    });

    it('requires a version', async () => {
      const { log } = await openDowntimeLog();
      const res = await updateLog(tech, log.id, { remedyAction: 'x' }).expect(400);
      expect(res.body.details).toContainEqual(expect.objectContaining({ field: 'version' }));
    });
  });

  describe('DELETE /machine-logs/:id', () => {
    it('only administrators can delete; deleting the latest log reverts the machine status', async () => {
      const machine = await createMachine(ctx);
      const first = await createLog(tech, {
        machineId: machine.id,
        faultDescription: 'Fault',
        entryStatus: 'ACTIVE',
        resultingState: 'DOWNTIME',
      }).expect(201);
      const second = await createLog(tech, {
        machineId: machine.id,
        faultDescription: 'Under repair',
        entryStatus: 'DOWNTIME',
        resultingState: 'UNDER_MAINTENANCE',
      }).expect(201);

      const forbidden = await request(ctx.app)
        .delete(`/api/v1/machine-logs/${second.body.data.id}`)
        .set(tech.auth)
        .expect(403);
      expect(forbidden.body.code).toBe('FORBIDDEN');

      await request(ctx.app)
        .delete(`/api/v1/machine-logs/${second.body.data.id}`)
        .set(admin.auth)
        .expect(200);
      expect(await machineStatus(ctx, machine.id)).toBe('DOWNTIME');
      await expectStatusMatchesLatestLog(ctx, machine.id);

      await request(ctx.app).get(`/api/v1/machine-logs/${second.body.data.id}`).set(admin.auth).expect(404);
      const deletedAudit = await ctx.container.dataSource
        .getRepository(AuditLog)
        .findOneByOrFail({ action: 'MACHINE_LOG_DELETED' });
      expect(deletedAudit.oldValues).toMatchObject({ wasLatest: true, resultingState: 'UNDER_MAINTENANCE' });

      await request(ctx.app).delete(`/api/v1/machine-logs/${first.body.data.id}`).set(admin.auth).expect(200);
      expect(await machineStatus(ctx, machine.id)).toBe('ACTIVE');
    });

    it('deleting a historical log leaves the status unchanged', async () => {
      const machine = await createMachine(ctx);
      const first = await createLog(tech, {
        machineId: machine.id,
        faultDescription: 'a',
        entryStatus: 'ACTIVE',
        resultingState: 'UNDER_TEST',
      }).expect(201);
      await createLog(tech, {
        machineId: machine.id,
        faultDescription: 'b',
        entryStatus: 'UNDER_TEST',
        resultingState: 'ACTIVE',
      }).expect(201);

      await request(ctx.app).delete(`/api/v1/machine-logs/${first.body.data.id}`).set(admin.auth).expect(200);
      expect(await machineStatus(ctx, machine.id)).toBe('ACTIVE');
    });
  });

  describe('history and listing', () => {
    it('returns machine history newest first with pagination and filters', async () => {
      const machine = await createMachine(ctx);
      const other = await createMachine(ctx);
      const steps = [
        ['ACTIVE', 'DOWNTIME', 'Fault 1'],
        ['DOWNTIME', 'UNDER_MAINTENANCE', 'Fault 2'],
        ['UNDER_MAINTENANCE', 'UNDER_TEST', 'Fault 3'],
      ] as const;
      for (const [entryStatus, resultingState, faultDescription] of steps) {
        await createLog(tech, {
          machineId: machine.id,
          faultDescription,
          entryStatus,
          resultingState,
        }).expect(201);
      }
      await createLog(admin, {
        machineId: other.id,
        faultDescription: 'Other',
        entryStatus: 'ACTIVE',
        resultingState: 'DOWNTIME',
      }).expect(201);

      const history = await request(ctx.app)
        .get(`/api/v1/machines/${machine.id}/logs?limit=2`)
        .set(tech.auth)
        .expect(200);
      expect(history.body.data.map((l: { faultDescription: string }) => l.faultDescription)).toEqual([
        'Fault 3',
        'Fault 2',
      ]);
      expect(history.body.meta).toEqual({ page: 1, limit: 2, totalItems: 3, totalPages: 2 });
      expect(history.body.data[0]).toEqual(
        expect.objectContaining({
          createdAt: expect.any(String),
          technician: expect.objectContaining({ fullName: tech.user.fullName }),
          faultDescription: 'Fault 3',
          causeDescription: null,
          remedyAction: null,
          entryStatus: 'UNDER_MAINTENANCE',
          resultingState: 'UNDER_TEST',
          downtimeHours: 0,
          logStatus: 'OPEN',
          nextMaintenancePlan: null,
        }),
      );

      const filtered = await request(ctx.app)
        .get(
          `/api/v1/machine-logs?machineId=${machine.id}&resultingState=DOWNTIME&logStatus=OPEN&page=1&limit=20`,
        )
        .set(tech.auth)
        .expect(200);
      expect(filtered.body.meta.totalItems).toBe(1);

      const byUser = await request(ctx.app)
        .get(`/api/v1/machine-logs?userId=${admin.user.id}`)
        .set(tech.auth)
        .expect(200);
      expect(byUser.body.data.map((l: { faultDescription: string }) => l.faultDescription)).toEqual([
        'Other',
      ]);

      const today = new Date().toISOString().slice(0, 10);
      const inRange = await request(ctx.app)
        .get(`/api/v1/machine-logs?from=${today}&to=${today}`)
        .set(tech.auth)
        .expect(200);
      expect(inRange.body.meta.totalItems).toBe(4);
      const outOfRange = await request(ctx.app)
        .get('/api/v1/machine-logs?from=2020-01-01&to=2020-01-31')
        .set(tech.auth)
        .expect(200);
      expect(outOfRange.body.meta.totalItems).toBe(0);

      const search = await request(ctx.app)
        .get('/api/v1/machine-logs?search=fault%202')
        .set(tech.auth)
        .expect(200);
      expect(search.body.meta.totalItems).toBe(1);
    });

    it('validates filters', async () => {
      const inverted = await request(ctx.app)
        .get('/api/v1/machine-logs?from=2026-02-01&to=2026-01-01')
        .set(tech.auth)
        .expect(400);
      expect(inverted.body.details).toContainEqual({
        field: 'query.to',
        message: 'must be on or after from',
      });
      await request(ctx.app).get('/api/v1/machine-logs?logStatus=PENDING').set(tech.auth).expect(400);
      await request(ctx.app).get('/api/v1/machine-logs?from=01-02-2026').set(tech.auth).expect(400);
      await request(ctx.app).get('/api/v1/machines/999999/logs').set(tech.auth).expect(404);
    });

    it('keeps history visible after the author is deleted', async () => {
      const machine = await createMachine(ctx);
      const created = await createLog(tech, {
        machineId: machine.id,
        faultDescription: 'By a former employee',
        entryStatus: 'ACTIVE',
        resultingState: 'ACTIVE',
      }).expect(201);
      await request(ctx.app).delete(`/api/v1/users/${tech.user.id}`).set(admin.auth).expect(200);

      const res = await request(ctx.app)
        .get(`/api/v1/machine-logs/${created.body.data.id}`)
        .set(admin.auth)
        .expect(200);
      expect(res.body.data.technician).toEqual({
        id: tech.user.id,
        fullName: tech.user.fullName,
        position: 'Technician',
      });
    });

    it('exposes the transition rules for clients', async () => {
      const res = await request(ctx.app).get('/api/v1/machines/state-transitions').set(tech.auth).expect(200);
      expect(res.body.data.transitions.ACTIVE).toEqual([
        'ACTIVE',
        'UNDER_MAINTENANCE',
        'DOWNTIME',
        'UNDER_TEST',
      ]);
      expect(res.body.data.statesRequiringOpenLog).toEqual(['DOWNTIME', 'UNDER_MAINTENANCE']);
    });

    it('reports activity counts on machines', async () => {
      const machine = await createMachine(ctx);
      await createLog(tech, {
        machineId: machine.id,
        faultDescription: 'a',
        entryStatus: 'ACTIVE',
        resultingState: 'DOWNTIME',
      }).expect(201);
      const res = await request(ctx.app).get(`/api/v1/machines/${machine.id}`).set(tech.auth).expect(200);
      expect(res.body.data).toMatchObject({ status: 'DOWNTIME', activity: { totalLogs: 1, openLogs: 1 } });

      const blocked = await request(ctx.app)
        .delete(`/api/v1/machines/${machine.id}`)
        .set(admin.auth)
        .expect(409);
      expect(blocked.body.code).toBe('MACHINE_HAS_OPEN_LOGS');
    });
  });
});
