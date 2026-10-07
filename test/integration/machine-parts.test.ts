import request from 'supertest';
import { AuditLog } from '../../src/audit/audit-log.entity';
import { MachineState } from '../../src/common/enums/machine-state.enum';
import {
  MACHINE_OPERATIONAL_STATUS_UPDATED,
  MACHINE_PART_UPDATED,
  type MachineOperationalStatusUpdatedEvent,
  type MachinePartUpdatedEvent,
} from '../../src/common/events/domain-events';
import { MachinePart } from '../../src/machine-parts/machine-part.entity';
import {
  adminSession,
  createMachine,
  createPart,
  machineOperationalStatus,
  technicianSession,
  type Session,
} from '../helpers/factories';
import { createTestContext, resetDatabase, type TestContext } from '../helpers/test-app';

describe('Machine parts and derived machine status', () => {
  let ctx: TestContext;
  let admin: Session;
  let tech: Session;
  let machineId: number;
  let statusEvents: MachineOperationalStatusUpdatedEvent[];
  let partEvents: MachinePartUpdatedEvent[];
  let unsubscribe: (() => void)[];

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
    const machine = await createMachine(ctx, { name: 'Press 1', serialNumber: 'PRS-100' });
    machineId = machine.id;
    statusEvents = [];
    partEvents = [];
    unsubscribe = [
      ctx.container.events.subscribe(MACHINE_OPERATIONAL_STATUS_UPDATED, (e) => {
        statusEvents.push(e);
      }),
      ctx.container.events.subscribe(MACHINE_PART_UPDATED, (e) => {
        partEvents.push(e);
      }),
    ];
  });

  afterEach(() => {
    for (const off of unsubscribe) off();
  });

  const addPart = (body: Record<string, unknown>, session: Session = admin) =>
    request(ctx.app).post(`/api/v1/machines/${machineId}/parts`).set(session.auth).send(body);

  /** Part logs are machine logs with a machinePartId (previousStatus/resultingStatus kept for brevity). */
  const logPart = (
    partId: number,
    { previousStatus, resultingStatus, ...body }: Record<string, unknown>,
    session: Session = tech,
  ) =>
    request(ctx.app)
      .post('/api/v1/machine-logs')
      .set(session.auth)
      .send({
        machineId,
        machinePartId: partId,
        entryStatus: previousStatus,
        resultingState: resultingStatus,
        ...body,
      });

  const patchLog = (id: number, { resultingStatus, ...body }: Record<string, unknown>) =>
    request(ctx.app)
      .patch(`/api/v1/machine-logs/${id}`)
      .set(tech.auth)
      .send(resultingStatus === undefined ? body : { ...body, resultingState: resultingStatus });

  const machineDetail = async (): Promise<Record<string, unknown>> => {
    const res = await request(ctx.app).get(`/api/v1/machines/${machineId}`).set(admin.auth).expect(200);
    return res.body.data as Record<string, unknown>;
  };

  describe('part administration (ADMIN)', () => {
    it('adds parts to an existing machine, which starts OPERATING', async () => {
      const res = await addPart({
        name: 'Hydraulic pump',
        partCode: 'a2',
        description: 'Main pump',
        isCritical: true,
      }).expect(201);

      expect(res.body.data).toMatchObject({
        machineId,
        partCode: 'A2',
        name: 'Hydraulic pump',
        status: 'ACTIVE',
        operationalImpact: 'NON_BLOCKING',
        isCritical: true,
        isActive: true,
        hasDefect: false,
        isBlockingMachine: false,
      });
      expect(await machineOperationalStatus(ctx, machineId)).toBe('OPERATING');

      const detail = await machineDetail();
      expect(detail).toMatchObject({
        status: 'ACTIVE',
        operationalStatus: 'OPERATING',
        parts: { total: 1, active: 1, critical: 1, blocking: 0 },
        maintenanceSchedules: [],
      });
      expect(detail.partDetails).toMatchObject([{ nextMaintenance: null }]);

      const audit = await ctx.container.dataSource
        .getRepository(AuditLog)
        .findOneByOrFail({ action: 'MACHINE_PART_CREATED' });
      expect(audit).toMatchObject({ userId: admin.user.id, entity: 'MACHINE_PART' });
    });

    it('allows a starting status other than ACTIVE when configured deliberately', async () => {
      const res = await addPart({
        name: 'Worn belt',
        partCode: 'B1',
        status: 'DOWNTIME',
        operationalImpact: 'BLOCKING',
      }).expect(201);
      expect(res.body.data).toMatchObject({ status: 'DOWNTIME', isBlockingMachine: true });
      expect(await machineOperationalStatus(ctx, machineId)).toBe('NOT_OPERATING');
    });

    it('keeps part codes unique per machine but allows reuse on another machine', async () => {
      await addPart({ name: 'Pump', partCode: 'A1' }).expect(201);
      const duplicate = await addPart({ name: 'Other pump', partCode: 'a1' }).expect(409);
      expect(duplicate.body.code).toBe('MACHINE_PART_CODE_EXISTS');

      const other = await createMachine(ctx);
      await request(ctx.app)
        .post(`/api/v1/machines/${other.id}/parts`)
        .set(admin.auth)
        .send({ name: 'Pump', partCode: 'A1' })
        .expect(201);
    });

    it('rejects status and impact on update: they change only through part logs', async () => {
      const part = await createPart(ctx, machineId, { partCode: 'A1' });
      const res = await request(ctx.app)
        .patch(`/api/v1/machines/${machineId}/parts/${part.id}`)
        .set(admin.auth)
        .send({ status: 'DOWNTIME', operationalImpact: 'BLOCKING' })
        .expect(400);
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          { field: 'status', message: 'is not allowed' },
          { field: 'operationalImpact', message: 'is not allowed' },
        ]),
      );
    });

    it('recalculates machine status when a part is deactivated or deleted', async () => {
      const part = await createPart(ctx, machineId, {
        partCode: 'A2',
        status: MachineState.DOWNTIME,
        operationalImpact: 'BLOCKING' as never,
      });
      await request(ctx.app)
        .patch(`/api/v1/machines/${machineId}/parts/${part.id}`)
        .set(admin.auth)
        .send({ isActive: false })
        .expect(200);
      expect(await machineOperationalStatus(ctx, machineId)).toBe('OPERATING');

      await request(ctx.app)
        .patch(`/api/v1/machines/${machineId}/parts/${part.id}`)
        .set(admin.auth)
        .send({ isActive: true })
        .expect(200);
      expect(await machineOperationalStatus(ctx, machineId)).toBe('NOT_OPERATING');

      await request(ctx.app)
        .delete(`/api/v1/machines/${machineId}/parts/${part.id}`)
        .set(admin.auth)
        .expect(200);
      expect(await machineOperationalStatus(ctx, machineId)).toBe('OPERATING');
      const row = await ctx.container.dataSource
        .getRepository(MachinePart)
        .findOne({ where: { id: part.id }, withDeleted: true });
      expect(row?.deletedAt).toBeInstanceOf(Date);
    });

    it('renames a part, keeps codes unique on update and ignores a no-op patch', async () => {
      const pump = await createPart(ctx, machineId, { partCode: 'C1', name: 'Pump' });
      const motor = await createPart(ctx, machineId, { partCode: 'C2', name: 'Motor' });

      const renamed = await request(ctx.app)
        .patch(`/api/v1/machines/${machineId}/parts/${pump.id}`)
        .set(admin.auth)
        .send({ name: 'Coolant pump', partCode: 'C9', description: 'Primary coolant circuit' })
        .expect(200);
      expect(renamed.body.data).toMatchObject({
        name: 'Coolant pump',
        partCode: 'C9',
        description: 'Primary coolant circuit',
      });

      const clash = await request(ctx.app)
        .patch(`/api/v1/machines/${machineId}/parts/${motor.id}`)
        .set(admin.auth)
        .send({ partCode: 'c9' })
        .expect(409);
      expect(clash.body.code).toBe('MACHINE_PART_CODE_EXISTS');

      // Re-sending the same values changes nothing and is still answered with the part.
      const noop = await request(ctx.app)
        .patch(`/api/v1/machines/${machineId}/parts/${pump.id}`)
        .set(admin.auth)
        .send({ name: 'Coolant pump' })
        .expect(200);
      expect(noop.body.data).toMatchObject({ id: pump.id, name: 'Coolant pump' });

      const missing = await request(ctx.app)
        .patch(`/api/v1/machines/${machineId}/parts/999999`)
        .set(admin.auth)
        .send({ name: 'Nope' })
        .expect(404);
      expect(missing.body.code).toBe('MACHINE_PART_NOT_FOUND');
    });

    it('is forbidden for technicians', async () => {
      const part = await createPart(ctx, machineId);
      const create = await addPart({ name: 'X', partCode: 'X1' }, tech).expect(403);
      expect(create.body.code).toBe('FORBIDDEN');
      await request(ctx.app)
        .patch(`/api/v1/machines/${machineId}/parts/${part.id}`)
        .set(tech.auth)
        .send({ name: 'Renamed' })
        .expect(403);
      await request(ctx.app)
        .delete(`/api/v1/machines/${machineId}/parts/${part.id}`)
        .set(tech.auth)
        .expect(403);
    });
  });

  describe('part logs drive the derived machine status', () => {
    it('non-blocking maintenance on one part leaves the machine OPERATING_WITH_DEFECTS', async () => {
      const a1 = await createPart(ctx, machineId, { partCode: 'A1' });
      const a2 = await createPart(ctx, machineId, { partCode: 'A2', isCritical: false });

      const res = await logPart(a2.id, {
        previousStatus: 'ACTIVE',
        resultingStatus: 'UNDER_MAINTENANCE',
        faultDescription: 'Seal weeping',
        causeDescription: 'Worn seal',
      }).expect(201);

      expect(res.body.data).toMatchObject({
        scope: 'PART',
        machinePart: { id: a2.id, partCode: 'A2' },
        technician: { id: tech.user.id },
        entryStatus: 'ACTIVE',
        resultingState: 'UNDER_MAINTENANCE',
        operationalImpact: 'NON_BLOCKING',
        machineStatusBefore: 'ACTIVE',
        machineStatusAfter: 'UNDER_MAINTENANCE',
        operationalStatusBefore: 'OPERATING',
        operationalStatusAfter: 'OPERATING_WITH_DEFECTS',
        logStatus: 'OPEN',
        version: 1,
      });
      expect(await machineOperationalStatus(ctx, machineId)).toBe('OPERATING_WITH_DEFECTS');

      const detail = await machineDetail();
      expect(detail.parts).toMatchObject({ total: 2, active: 1, underMaintenance: 1, blocking: 0 });
      // The machine follows its part: it is not reported ACTIVE while A2 is under maintenance.
      expect(detail).toMatchObject({
        status: 'UNDER_MAINTENANCE',
        systemStatus: 'ACTIVE',
        operationalStatus: 'OPERATING_WITH_DEFECTS',
      });

      expect(partEvents).toEqual([
        expect.objectContaining({
          partId: a2.id,
          previousStatus: 'ACTIVE',
          newStatus: 'UNDER_MAINTENANCE',
          operationalImpact: 'NON_BLOCKING',
        }),
      ]);
      expect(statusEvents).toEqual([
        expect.objectContaining({
          machineId,
          previousStatus: 'OPERATING',
          newStatus: 'OPERATING_WITH_DEFECTS',
          trigger: { type: 'MACHINE_LOG', logId: res.body.data.id, scope: 'PART', partId: a2.id },
          reason: expect.stringContaining('A2'),
        }),
      ]);
      expect(a1.status).toBe('ACTIVE');
    });

    it('a blocking condition on a critical part stops the machine', async () => {
      const critical = await createPart(ctx, machineId, { partCode: 'A2', isCritical: true });
      await createPart(ctx, machineId, { partCode: 'A3' });

      await logPart(critical.id, {
        previousStatus: 'ACTIVE',
        resultingStatus: 'DOWNTIME',
        faultDescription: 'Pump seized',
      }).expect(201);

      expect(await machineOperationalStatus(ctx, machineId)).toBe('NOT_OPERATING');
      expect(statusEvents.at(-1)).toMatchObject({ newStatus: 'NOT_OPERATING' });
      const audits = (await ctx.container.dataSource.getRepository(AuditLog).find()).map((a) => a.action);
      expect(audits).toEqual(
        expect.arrayContaining([
          'MACHINE_LOG_CREATED',
          'MACHINE_PART_STATUS_CHANGED',
          'MACHINE_STATUS_CHANGED',
          'MACHINE_OPERATIONAL_STATUS_CHANGED',
        ]),
      );
    });

    it('recovers through the part lifecycle, keeping remaining defects visible', async () => {
      const critical = await createPart(ctx, machineId, { partCode: 'A1', isCritical: true });
      const minor = await createPart(ctx, machineId, { partCode: 'A2' });

      await logPart(critical.id, {
        previousStatus: 'ACTIVE',
        resultingStatus: 'DOWNTIME',
        faultDescription: 'Motor failure',
      }).expect(201);
      await logPart(minor.id, {
        previousStatus: 'ACTIVE',
        resultingStatus: 'UNDER_MAINTENANCE',
        faultDescription: 'Noise',
      }).expect(201);
      expect(await machineOperationalStatus(ctx, machineId)).toBe('NOT_OPERATING');

      // Repair the critical part: a non-blocking defect remains on the other part.
      await logPart(critical.id, {
        previousStatus: 'DOWNTIME',
        resultingStatus: 'ACTIVE',
        faultDescription: 'Motor replaced',
        remedyAction: 'New motor fitted',
        logStatus: 'CLOSED',
      }).expect(201);
      expect(await machineOperationalStatus(ctx, machineId)).toBe('OPERATING_WITH_DEFECTS');

      // Finish the minor work too.
      await logPart(minor.id, {
        previousStatus: 'UNDER_MAINTENANCE',
        resultingStatus: 'ACTIVE',
        faultDescription: 'Adjusted',
        logStatus: 'CLOSED',
      }).expect(201);
      expect(await machineOperationalStatus(ctx, machineId)).toBe('OPERATING');
      expect(statusEvents.map((e) => e.newStatus)).toEqual([
        'NOT_OPERATING',
        'OPERATING_WITH_DEFECTS',
        'OPERATING',
      ]);
    });

    it('a blocking condition on a non-critical part also stops the machine when stated', async () => {
      const part = await createPart(ctx, machineId, { partCode: 'A4', isCritical: false });
      await logPart(part.id, {
        previousStatus: 'ACTIVE',
        resultingStatus: 'UNDER_TEST',
        operationalImpact: 'BLOCKING',
        faultDescription: 'Test run requires the line to stop',
      }).expect(201);
      expect(await machineOperationalStatus(ctx, machineId)).toBe('NOT_OPERATING');
    });

    it('rejects a stale previousStatus and changes nothing', async () => {
      const part = await createPart(ctx, machineId, { partCode: 'A5', status: MachineState.DOWNTIME });
      const before = await machineOperationalStatus(ctx, machineId);

      const res = await logPart(part.id, {
        previousStatus: 'ACTIVE',
        resultingStatus: 'UNDER_TEST',
        faultDescription: 'Stale view',
      }).expect(409);

      expect(res.body.code).toBe('MACHINE_PART_STATE_CONFLICT');
      // Nothing was written: neither the part condition nor the machine status moved.
      const stored = await ctx.container.dataSource
        .getRepository(MachinePart)
        .findOneByOrFail({ id: part.id });
      expect(stored.status).toBe(MachineState.DOWNTIME);
      expect(await machineOperationalStatus(ctx, machineId)).toBe(before);
      expect(partEvents).toHaveLength(0);
      expect(statusEvents).toHaveLength(0);
    });

    it('serialises concurrent part logs: one wins, the rest conflict', async () => {
      const part = await createPart(ctx, machineId, { partCode: 'A6' });
      const results = await Promise.all(
        ['DOWNTIME', 'UNDER_MAINTENANCE', 'UNDER_TEST'].map((resultingStatus) =>
          logPart(part.id, { previousStatus: 'ACTIVE', resultingStatus, faultDescription: 'Race' }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    });

    it('updates a part log with optimistic concurrency and syncs the latest condition', async () => {
      const part = await createPart(ctx, machineId, { partCode: 'A7', isCritical: true });
      const created = await logPart(part.id, {
        previousStatus: 'ACTIVE',
        resultingStatus: 'DOWNTIME',
        faultDescription: 'Leak',
      }).expect(201);
      expect(await machineOperationalStatus(ctx, machineId)).toBe('NOT_OPERATING');

      const updated = await patchLog(created.body.data.id, {
        version: 1,
        resultingStatus: 'UNDER_TEST',
        operationalImpact: 'NON_BLOCKING',
        remedyAction: 'Resealed',
      }).expect(200);
      expect(updated.body.data).toMatchObject({ resultingState: 'UNDER_TEST', version: 2 });
      expect(await machineOperationalStatus(ctx, machineId)).toBe('OPERATING_WITH_DEFECTS');

      const stale = await patchLog(created.body.data.id, { version: 1, remedyAction: 'again' }).expect(409);
      expect(stale.body.code).toBe('STALE_VERSION');
    });

    it('exposes part history and cross-machine part logs with filters', async () => {
      const part = await createPart(ctx, machineId, { partCode: 'A8' });
      await logPart(part.id, {
        previousStatus: 'ACTIVE',
        resultingStatus: 'DOWNTIME',
        faultDescription: 'First fault',
      }).expect(201);
      await logPart(part.id, {
        previousStatus: 'DOWNTIME',
        resultingStatus: 'ACTIVE',
        faultDescription: 'Repaired',
        logStatus: 'CLOSED',
      }).expect(201);

      const history = await request(ctx.app)
        .get(`/api/v1/machine-parts/${part.id}/logs`)
        .set(tech.auth)
        .expect(200);
      expect(history.body.data.map((l: { faultDescription: string }) => l.faultDescription)).toEqual([
        'Repaired',
        'First fault',
      ]);
      expect(history.body.meta.totalItems).toBe(2);

      // Part logs are part of the machine's own history.
      const machineHistory = await request(ctx.app)
        .get(`/api/v1/machines/${machineId}/logs?scope=PART`)
        .set(tech.auth)
        .expect(200);
      expect(machineHistory.body.meta.totalItems).toBe(2);

      const filtered = await request(ctx.app)
        .get(`/api/v1/machine-logs?machineId=${machineId}&scope=PART&logStatus=CLOSED`)
        .set(tech.auth)
        .expect(200);
      expect(filtered.body.meta.totalItems).toBe(1);
      await request(ctx.app).get('/api/v1/machine-logs?scope=NOPE').set(tech.auth).expect(400);

      const today = new Date().toISOString().slice(0, 10);
      const narrow = await request(ctx.app)
        .get(
          `/api/v1/machine-logs?machinePartId=${part.id}&userId=${tech.user.id}` +
            `&resultingState=DOWNTIME&operationalImpact=NON_BLOCKING&from=${today}&to=${today}&search=First`,
        )
        .set(tech.auth)
        .expect(200);
      expect(narrow.body.meta.totalItems).toBe(1);
      expect(narrow.body.data[0]).toMatchObject({ faultDescription: 'First fault' });

      const otherUser = await request(ctx.app)
        .get(`/api/v1/machine-logs?scope=PART&userId=${admin.user.id}`)
        .set(tech.auth)
        .expect(200);
      expect(otherUser.body.meta.totalItems).toBe(0);
    });

    it('closes and reopens a part log, recomputing downtime from the timestamps', async () => {
      const part = await createPart(ctx, machineId, { partCode: 'A9' });
      const created = await logPart(part.id, {
        previousStatus: 'ACTIVE',
        resultingStatus: 'UNDER_TEST',
        faultDescription: 'Trial run after rebuild',
        startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      }).expect(201);
      expect(created.body.data).toMatchObject({ logStatus: 'OPEN', endedAt: null, downtimeHours: 0 });

      // Closing without an explicit endedAt stamps "now" and derives the downtime.
      const closed = await patchLog(created.body.data.id, {
        version: 1,
        logStatus: 'CLOSED',
        causeDescription: 'Debris',
        remedyAction: 'Cleared',
      }).expect(200);
      expect(closed.body.data).toMatchObject({ logStatus: 'CLOSED', causeDescription: 'Debris' });
      expect(closed.body.data.endedAt).not.toBeNull();
      expect(closed.body.data.downtimeHours).toBeCloseTo(2, 1);

      // Reopening clears the end timestamp again.
      const reopened = await patchLog(created.body.data.id, { version: 2, logStatus: 'OPEN' }).expect(200);
      expect(reopened.body.data).toMatchObject({ logStatus: 'OPEN', endedAt: null });

      // A log that leaves the part in DOWNTIME has to stay open.
      const stillDown = await logPart(part.id, {
        previousStatus: 'UNDER_TEST',
        resultingStatus: 'DOWNTIME',
        faultDescription: 'Failed the trial',
        logStatus: 'CLOSED',
      }).expect(422);
      expect(stillDown.body.code).toBe('INVALID_LOG_STATUS');

      // The part condition never changed, so the machine status is untouched.
      expect(await machineOperationalStatus(ctx, machineId)).toBe('OPERATING_WITH_DEFECTS');
    });

    it('edits an older log without touching the current part condition', async () => {
      const part = await createPart(ctx, machineId, { partCode: 'B1' });
      const first = await logPart(part.id, {
        previousStatus: 'ACTIVE',
        resultingStatus: 'UNDER_MAINTENANCE',
        faultDescription: 'Service due',
      }).expect(201);
      await logPart(part.id, {
        previousStatus: 'UNDER_MAINTENANCE',
        resultingStatus: 'ACTIVE',
        faultDescription: 'Serviced',
        logStatus: 'CLOSED',
      }).expect(201);
      expect(await machineOperationalStatus(ctx, machineId)).toBe('OPERATING');
      const statusEventCount = statusEvents.length;

      const corrected = await patchLog(first.body.data.id, {
        version: 1,
        faultDescription: 'Scheduled service (corrected)',
      }).expect(200);
      expect(corrected.body.data).toMatchObject({
        faultDescription: 'Scheduled service (corrected)',
        version: 2,
      });
      expect(await machineOperationalStatus(ctx, machineId)).toBe('OPERATING');
      expect(statusEvents).toHaveLength(statusEventCount);

      const immutable = await patchLog(first.body.data.id, {
        version: 2,
        resultingStatus: 'DOWNTIME',
      }).expect(409);
      expect(immutable.body.code).toBe('RESULTING_STATE_IMMUTABLE');

      await request(ctx.app).get('/api/v1/machine-logs/999999').set(tech.auth).expect(404);
      const missingPatch = await patchLog(999999, { version: 1, remedyAction: 'x' }).expect(404);
      expect(missingPatch.body.code).toBe('MACHINE_LOG_NOT_FOUND');
    });

    it('refuses to change the condition of a deactivated part', async () => {
      const part = await createPart(ctx, machineId, { partCode: 'B2' });
      const created = await logPart(part.id, {
        previousStatus: 'ACTIVE',
        resultingStatus: 'UNDER_TEST',
        faultDescription: 'Observation',
      }).expect(201);
      await request(ctx.app)
        .patch(`/api/v1/machines/${machineId}/parts/${part.id}`)
        .set(admin.auth)
        .send({ isActive: false })
        .expect(200);

      const res = await patchLog(created.body.data.id, { version: 1, resultingStatus: 'DOWNTIME' }).expect(
        422,
      );
      expect(res.body.code).toBe('MACHINE_PART_INACTIVE');

      await logPart(part.id, {
        previousStatus: 'UNDER_TEST',
        resultingStatus: 'ACTIVE',
        faultDescription: 'Retired part',
      }).expect(422);
    });
  });

  describe('machines without parts stay fully functional', () => {
    it('derives status from the machine workflow alone', async () => {
      const bare = await createMachine(ctx, { name: 'No parts' });
      const before = await request(ctx.app).get(`/api/v1/machines/${bare.id}`).set(admin.auth).expect(200);
      expect(before.body.data).toMatchObject({
        operationalStatus: 'OPERATING',
        parts: { total: 0 },
        partDetails: [],
      });

      await request(ctx.app)
        .post('/api/v1/machine-logs')
        .set(tech.auth)
        .send({
          machineId: bare.id,
          faultDescription: 'Whole machine stopped',
          entryStatus: 'ACTIVE',
          resultingState: 'DOWNTIME',
        })
        .expect(201);
      expect(await machineOperationalStatus(ctx, bare.id)).toBe('NOT_OPERATING');

      const after = await request(ctx.app).get(`/api/v1/machines/${bare.id}`).set(admin.auth).expect(200);
      expect(after.body.data).toMatchObject({ status: 'DOWNTIME', operationalStatus: 'NOT_OPERATING' });
    });

    it('machine-level maintenance stops the machine even when every part is active', async () => {
      await createPart(ctx, machineId, { partCode: 'A1' });
      await request(ctx.app)
        .post('/api/v1/machine-logs')
        .set(tech.auth)
        .send({
          machineId,
          faultDescription: 'Full service',
          entryStatus: 'ACTIVE',
          resultingState: 'UNDER_MAINTENANCE',
        })
        .expect(201);
      expect(await machineOperationalStatus(ctx, machineId)).toBe('NOT_OPERATING');
      expect(statusEvents.at(-1)).toMatchObject({
        newStatus: 'NOT_OPERATING',
        trigger: { type: 'MACHINE_LOG', logId: expect.any(Number) },
      });
    });
  });

  describe('listing and analytics', () => {
    it('filters, searches, sorts and paginates parts', async () => {
      await createPart(ctx, machineId, { partCode: 'A1', name: 'Pump', isCritical: true });
      await createPart(ctx, machineId, {
        partCode: 'A2',
        name: 'Valve',
        status: MachineState.DOWNTIME,
      });
      await createPart(ctx, machineId, { partCode: 'A3', name: 'Sensor', isActive: false });

      const list = (query: string) =>
        request(ctx.app).get(`/api/v1/machines/${machineId}/parts${query}`).set(tech.auth).expect(200);

      const page = await list('?limit=2&sortBy=partCode&sortOrder=asc');
      expect(page.body.data.map((p: { partCode: string }) => p.partCode)).toEqual(['A1', 'A2']);
      expect(page.body.meta).toEqual({ page: 1, limit: 2, totalItems: 3, totalPages: 2 });

      expect((await list('?status=DOWNTIME')).body.meta.totalItems).toBe(1);
      expect((await list('?isCritical=true')).body.meta.totalItems).toBe(1);
      expect((await list('?isActive=false')).body.meta.totalItems).toBe(1);
      expect((await list('?search=valve')).body.meta.totalItems).toBe(1);
      expect((await list('?search=%25')).body.meta.totalItems).toBe(0);

      await request(ctx.app)
        .get(`/api/v1/machines/${machineId}/parts?status=BROKEN`)
        .set(tech.auth)
        .expect(400);
      await request(ctx.app).get('/api/v1/machines/999999/parts').set(tech.auth).expect(404);
    });

    it('reports part conditions and the most problematic parts in analytics', async () => {
      const critical = await createPart(ctx, machineId, { partCode: 'A1', isCritical: true });
      await createPart(ctx, machineId, { partCode: 'A2' });
      await logPart(critical.id, {
        previousStatus: 'ACTIVE',
        resultingStatus: 'DOWNTIME',
        faultDescription: 'Seized',
      }).expect(201);
      await logPart(critical.id, {
        previousStatus: 'DOWNTIME',
        resultingStatus: 'ACTIVE',
        faultDescription: 'Rebuilt',
        logStatus: 'CLOSED',
        startedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        downtimeHours: 3,
      }).expect(201);

      const res = await request(ctx.app).get('/api/v1/analytics/parts').set(tech.auth).expect(200);
      expect(res.body.data).toMatchObject({
        byStatus: { total: 2, active: 2, critical: 1 },
        impact: { machinesWithPartIssues: 0, machinesStoppedByParts: 0 },
        totalPartDowntimeHours: 3,
      });
      expect(res.body.data.mostProblematic[0]).toMatchObject({
        machine: { id: machineId },
        part: { id: critical.id, partCode: 'A1', isCritical: true },
        events: 2,
        downtimeHours: 3,
      });

      const overview = await request(ctx.app).get('/api/v1/analytics/overview').set(tech.auth).expect(200);
      expect(overview.body.data).toMatchObject({
        machineOperational: { operating: expect.any(Number) },
        parts: { total: 2 },
        maintenance: { total: 0 },
      });
    });

    it('counts machines stopped by their parts', async () => {
      const critical = await createPart(ctx, machineId, { partCode: 'A1', isCritical: true });
      await logPart(critical.id, {
        previousStatus: 'ACTIVE',
        resultingStatus: 'DOWNTIME',
        faultDescription: 'Seized',
      }).expect(201);

      const res = await request(ctx.app).get('/api/v1/analytics/parts').set(admin.auth).expect(200);
      expect(res.body.data.impact).toEqual({ machinesWithPartIssues: 1, machinesStoppedByParts: 1 });
      expect(res.body.data.byStatus).toMatchObject({ downtime: 1, blocking: 1 });
    });
  });

  it('never accepts an operational status from a client', async () => {
    const create = await request(ctx.app)
      .post('/api/v1/machines')
      .set(admin.auth)
      .send({ name: 'X', serialNumber: 'X-1', operationalStatus: 'NOT_OPERATING' })
      .expect(400);
    expect(create.body.details).toContainEqual({ field: 'operationalStatus', message: 'is not allowed' });

    const patch = await request(ctx.app)
      .patch(`/api/v1/machines/${machineId}`)
      .set(admin.auth)
      .send({ operationalStatus: 'OPERATING_WITH_DEFECTS' })
      .expect(400);
    expect(patch.body.details).toContainEqual({
      field: 'operationalStatus',
      message: 'is not allowed',
    });
  });
});
