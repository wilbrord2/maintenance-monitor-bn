import request from 'supertest';
import { AuditLog } from '../../src/audit/audit-log.entity';
import { Machine } from '../../src/machines/machine.entity';
import { adminSession, technicianSession, type Session } from '../helpers/factories';
import { createTestContext, resetDatabase, type TestContext } from '../helpers/test-app';

describe('Machines', () => {
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
    admin = await adminSession(ctx);
  });

  const createMachine = (body: Record<string, unknown>) =>
    request(ctx.app).post('/api/v1/machines').set(admin.auth).send(body);

  it('creates a machine as ACTIVE, normalises the serial number and audits it', async () => {
    const res = await createMachine({
      name: 'Laser 1',
      serialNumber: ' lsr-001 ',
      description: 'Fiber laser',
    }).expect(201);

    expect(res.body).toMatchObject({
      success: true,
      message: 'Machine created successfully',
      data: {
        name: 'Laser 1',
        serialNumber: 'LSR-001',
        status: 'ACTIVE',
        isActive: true,
        activity: { totalLogs: 0, openLogs: 0, lastActivityAt: null },
      },
    });
    const audit = await ctx.container.dataSource
      .getRepository(AuditLog)
      .findOneByOrFail({ action: 'MACHINE_CREATED' });
    expect(audit).toMatchObject({ userId: admin.user.id, entityId: String(res.body.data.id) });
    expect(audit.newValues).toMatchObject({ serialNumber: 'LSR-001', status: 'ACTIVE' });
  });

  it('rejects duplicate serial numbers (case-insensitively) with MACHINE_SERIAL_EXISTS', async () => {
    await createMachine({ name: 'Press 1', serialNumber: 'PRS-1' }).expect(201);
    const res = await createMachine({ name: 'Press 2', serialNumber: 'prs-1' }).expect(409);
    expect(res.body).toMatchObject({
      success: false,
      message: 'Machine serial number already exists',
      code: 'MACHINE_SERIAL_EXISTS',
      path: '/api/v1/machines',
    });
  });

  it('enforces serial uniqueness at the database level under concurrent creation', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => createMachine({ name: 'Race', serialNumber: 'RACE-1' })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 409).every((r) => r.body.code === 'MACHINE_SERIAL_EXISTS'),
    ).toBe(true);
  });

  it('validates input', async () => {
    const res = await createMachine({ name: '', serialNumber: 'bad serial!' }).expect(400);
    const fields = (res.body.details as { field: string }[]).map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['name', 'serialNumber']));
  });

  it('lists machines with pagination, filtering, search and sorting for any role', async () => {
    for (const [name, serial] of [
      ['Compressor 1', 'CMP-1'],
      ['Compressor 2', 'CMP-2'],
      ['Chiller 1', 'CHL-1'],
    ]) {
      await createMachine({ name, serialNumber: serial }).expect(201);
    }
    await ctx.container.dataSource.query(
      `UPDATE machines SET status = 'DOWNTIME' WHERE serial_number = 'CHL-1'`,
    );
    const tech = await technicianSession(ctx);

    const page = await request(ctx.app)
      .get('/api/v1/machines?limit=2&sortBy=name&sortOrder=asc')
      .set(tech.auth)
      .expect(200);
    expect(page.body.data.map((m: { name: string }) => m.name)).toEqual(['Chiller 1', 'Compressor 1']);
    expect(page.body.meta).toEqual({ page: 1, limit: 2, totalItems: 3, totalPages: 2 });

    const down = await request(ctx.app).get('/api/v1/machines?status=DOWNTIME').set(tech.auth).expect(200);
    expect(down.body.data).toHaveLength(1);

    const search = await request(ctx.app).get('/api/v1/machines?search=cmp').set(tech.auth).expect(200);
    expect(search.body.meta.totalItems).toBe(2);

    await request(ctx.app).get('/api/v1/machines?status=BROKEN').set(tech.auth).expect(400);
    await request(ctx.app).get('/api/v1/machines?sortBy=password').set(tech.auth).expect(400);
  });

  it('updates machine details and audits only changed fields', async () => {
    const created = await createMachine({ name: 'Shear', serialNumber: 'SHR-1' }).expect(201);
    const res = await request(ctx.app)
      .patch(`/api/v1/machines/${created.body.data.id}`)
      .set(admin.auth)
      .send({ name: 'Shear Machine 1', description: 'Hydraulic' })
      .expect(200);
    expect(res.body.data).toMatchObject({
      name: 'Shear Machine 1',
      description: 'Hydraulic',
      status: 'ACTIVE',
    });

    const audit = await ctx.container.dataSource
      .getRepository(AuditLog)
      .findOneByOrFail({ action: 'MACHINE_UPDATED' });
    expect(audit.oldValues).toEqual({ name: 'Shear', description: null });
    expect(audit.newValues).toEqual({ name: 'Shear Machine 1', description: 'Hydraulic' });
  });

  it('deactivates, reactivates and soft-deletes machines', async () => {
    const created = await createMachine({ name: 'Beading', serialNumber: 'BD-1' }).expect(201);
    const id: number = created.body.data.id;

    const deactivated = await request(ctx.app)
      .post(`/api/v1/machines/${id}/deactivate`)
      .set(admin.auth)
      .expect(200);
    expect(deactivated.body.data.isActive).toBe(false);
    await request(ctx.app).post(`/api/v1/machines/${id}/activate`).set(admin.auth).expect(200);

    await request(ctx.app).delete(`/api/v1/machines/${id}`).set(admin.auth).expect(200);
    await request(ctx.app).get(`/api/v1/machines/${id}`).set(admin.auth).expect(404);
    const row = await ctx.container.dataSource
      .getRepository(Machine)
      .findOne({ where: { id }, withDeleted: true });
    expect(row?.deletedAt).toBeInstanceOf(Date);

    const actions = (await ctx.container.dataSource.getRepository(AuditLog).find()).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['MACHINE_DEACTIVATED', 'MACHINE_ACTIVATED', 'MACHINE_DELETED']),
    );
  });

  it('returns MACHINE_NOT_FOUND for unknown machines', async () => {
    const res = await request(ctx.app).get('/api/v1/machines/424242').set(admin.auth).expect(404);
    expect(res.body.code).toBe('MACHINE_NOT_FOUND');
  });
});
