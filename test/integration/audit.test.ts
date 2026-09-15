import request from 'supertest';
import { AuditAction } from '../../src/audit/audit.constants';
import {
  adminSession,
  createMachine,
  flushAsync,
  login,
  resetTokenFrom,
  TEST_PASSWORD,
  technicianSession,
  temporaryPasswordFrom,
  type Session,
} from '../helpers/factories';
import { createTestContext, resetDatabase, type TestContext } from '../helpers/test-app';

const NEW_PASSWORD = 'Another-Strong-Passw0rd';

describe('Audit logging', () => {
  let ctx: TestContext;
  let admin: Session;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.container.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.container);
    ctx.mail.clear();
    admin = await adminSession(ctx);
  });

  /** Drives one of every audited operation through the public API. */
  async function exerciseEverything() {
    await login(ctx, admin.user.email, 'Wrong-Passw0rd-1').expect(401);

    const created = await request(ctx.app)
      .post('/api/v1/users')
      .set(admin.auth)
      .send({ fullName: 'Audit Tech', email: 'audit.tech@example.test', phone: '0788000111' })
      .expect(201);
    const techId: number = created.body.data.user.id;
    const temporary = temporaryPasswordFrom(ctx.mail.lastTo('audit.tech@example.test')!.text);
    const techLogin = await login(ctx, 'audit.tech@example.test', temporary).expect(200);
    const changed = await request(ctx.app)
      .post('/api/v1/auth/change-password')
      .set({ Authorization: `Bearer ${techLogin.body.data.tokens.accessToken}` })
      .send({ currentPassword: temporary, newPassword: NEW_PASSWORD })
      .expect(200);
    const techAuth = { Authorization: `Bearer ${changed.body.data.tokens.accessToken}` };

    await request(ctx.app)
      .patch(`/api/v1/users/${techId}`)
      .set(admin.auth)
      .send({ position: 'Lead' })
      .expect(200);

    const machine = await request(ctx.app)
      .post('/api/v1/machines')
      .set(admin.auth)
      .send({ name: 'Audit Press', serialNumber: 'AUD-1' })
      .expect(201);
    const machineId: number = machine.body.data.id;
    await request(ctx.app)
      .patch(`/api/v1/machines/${machineId}`)
      .set(admin.auth)
      .send({ name: 'Audit Press 1' })
      .expect(200);

    const log = await request(ctx.app)
      .post('/api/v1/machine-logs')
      .set(techAuth)
      .send({ machineId, faultDescription: 'Noise', entryStatus: 'ACTIVE', resultingState: 'UNDER_TEST' })
      .expect(201);
    await request(ctx.app)
      .patch(`/api/v1/machine-logs/${log.body.data.id}`)
      .set(techAuth)
      .send({ version: 1, remedyAction: 'Tightened bolts' })
      .expect(200);
    await request(ctx.app).delete(`/api/v1/machine-logs/${log.body.data.id}`).set(admin.auth).expect(200);

    const spare = await createMachine(ctx);
    await request(ctx.app).post(`/api/v1/machines/${spare.id}/deactivate`).set(admin.auth).expect(200);
    await request(ctx.app).post(`/api/v1/machines/${spare.id}/activate`).set(admin.auth).expect(200);
    await request(ctx.app).delete(`/api/v1/machines/${spare.id}`).set(admin.auth).expect(200);

    await request(ctx.app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'audit.tech@example.test' })
      .expect(200);
    await flushAsync();
    const token = resetTokenFrom(ctx.mail.lastTo('audit.tech@example.test')!.text);
    await request(ctx.app)
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'Reset-Passw0rd-123' })
      .expect(200);

    await request(ctx.app).post(`/api/v1/users/${techId}/deactivate`).set(admin.auth).expect(200);
    await request(ctx.app).post(`/api/v1/users/${techId}/activate`).set(admin.auth).expect(200);
    await request(ctx.app).delete(`/api/v1/users/${techId}`).set(admin.auth).expect(200);
    await request(ctx.app).post('/api/v1/auth/logout').set(admin.auth).expect(200);
    return { techId, machineId };
  }

  it('records every required auditable action without credentials', async () => {
    await exerciseEverything();
    const rows: {
      action: string;
      old_values: unknown;
      new_values: unknown;
      ip_address: string | null;
      request_id: string | null;
    }[] = await ctx.container.dataSource.query(
      'SELECT action, old_values, new_values, ip_address, request_id FROM audit_logs',
    );
    const actions = new Set(rows.map((row) => row.action));

    const required = [
      AuditAction.LOGIN_SUCCEEDED,
      AuditAction.LOGIN_FAILED,
      AuditAction.LOGOUT,
      AuditAction.PASSWORD_CHANGED,
      AuditAction.PASSWORD_RESET_REQUESTED,
      AuditAction.PASSWORD_RESET_COMPLETED,
      AuditAction.TECHNICIAN_CREATED,
      AuditAction.USER_UPDATED,
      AuditAction.USER_DEACTIVATED,
      AuditAction.USER_ACTIVATED,
      AuditAction.USER_DELETED,
      AuditAction.MACHINE_CREATED,
      AuditAction.MACHINE_UPDATED,
      AuditAction.MACHINE_DEACTIVATED,
      AuditAction.MACHINE_ACTIVATED,
      AuditAction.MACHINE_DELETED,
      AuditAction.MACHINE_LOG_CREATED,
      AuditAction.MACHINE_LOG_UPDATED,
      AuditAction.MACHINE_LOG_DELETED,
      AuditAction.MACHINE_STATUS_CHANGED,
    ];
    for (const action of required) expect(actions).toContain(action);

    const serialized = JSON.stringify(rows);
    for (const secret of [
      TEST_PASSWORD,
      NEW_PASSWORD,
      'Reset-Passw0rd-123',
      admin.refreshToken,
      admin.accessToken,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toMatch(/\$argon2/);
    expect(rows.every((row) => row.ip_address !== null && row.request_id !== null)).toBe(true);
  });

  it('lets administrators browse and filter the trail', async () => {
    const { machineId } = await exerciseEverything();
    const fresh = await adminSession(ctx);

    const page = await request(ctx.app).get('/api/v1/audit-logs?limit=5').set(fresh.auth).expect(200);
    expect(page.body.data).toHaveLength(5);
    expect(page.body.meta.totalItems).toBeGreaterThan(20);
    const timestamps = page.body.data.map((entry: { createdAt: string }) => entry.createdAt);
    expect([...timestamps].sort().reverse()).toEqual(timestamps);

    const statusChanges = await request(ctx.app)
      .get(`/api/v1/audit-logs?action=MACHINE_STATUS_CHANGED&entity=MACHINE&entityId=${machineId}`)
      .set(fresh.auth)
      .expect(200);
    expect(
      statusChanges.body.data.map(
        (e: { oldValues: { status: string }; newValues: { status: string } }) =>
          `${e.oldValues.status}->${e.newValues.status}`,
      ),
    ).toEqual(['UNDER_TEST->ACTIVE', 'ACTIVE->UNDER_TEST']);

    const byUser = await request(ctx.app)
      .get(`/api/v1/audit-logs?userId=${admin.user.id}&action=MACHINE_CREATED`)
      .set(fresh.auth)
      .expect(200);
    expect(byUser.body.data[0].user).toEqual({
      id: admin.user.id,
      fullName: admin.user.fullName,
      email: admin.user.email,
    });

    const single = await request(ctx.app)
      .get(`/api/v1/audit-logs/${byUser.body.data[0].id}`)
      .set(fresh.auth)
      .expect(200);
    expect(single.body.data.action).toBe('MACHINE_CREATED');

    const today = new Date().toISOString().slice(0, 10);
    const ranged = await request(ctx.app)
      .get(`/api/v1/audit-logs?from=${today}&to=${today}&limit=1`)
      .set(fresh.auth)
      .expect(200);
    expect(ranged.body.meta.totalItems).toBe(page.body.meta.totalItems);

    await request(ctx.app).get('/api/v1/audit-logs?action=NOT_AN_ACTION').set(fresh.auth).expect(400);
    await request(ctx.app).get('/api/v1/audit-logs/999999999').set(fresh.auth).expect(404);
  });

  it('is restricted to administrators', async () => {
    const tech = await technicianSession(ctx);
    const res = await request(ctx.app).get('/api/v1/audit-logs').set(tech.auth).expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    await request(ctx.app).get('/api/v1/audit-logs').expect(401);
  });

  it('keeps audit entries when the acting user is later deleted', async () => {
    const tech = await technicianSession(ctx);
    const machine = await createMachine(ctx);
    await request(ctx.app)
      .post('/api/v1/machine-logs')
      .set(tech.auth)
      .send({
        machineId: machine.id,
        faultDescription: 'x',
        entryStatus: 'ACTIVE',
        resultingState: 'DOWNTIME',
      })
      .expect(201);
    await request(ctx.app).delete(`/api/v1/users/${tech.user.id}`).set(admin.auth).expect(200);

    const res = await request(ctx.app)
      .get(`/api/v1/audit-logs?userId=${tech.user.id}&action=MACHINE_LOG_CREATED`)
      .set(admin.auth)
      .expect(200);
    expect(res.body.data[0].user).toMatchObject({ id: tech.user.id });
  });
});
