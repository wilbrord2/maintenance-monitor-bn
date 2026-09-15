import request from 'supertest';
import { adminSession, technicianSession, type Session } from '../helpers/factories';
import { createTestContext, resetDatabase, type TestContext } from '../helpers/test-app';

describe('Security: machine status cannot be changed directly', () => {
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
    const created = await request(ctx.app)
      .post('/api/v1/machines')
      .set(admin.auth)
      .send({ name: 'Press 1', serialNumber: 'PRS-001' })
      .expect(201);
    machineId = created.body.data.id;
  });

  const currentStatus = async (): Promise<string> => {
    const res = await request(ctx.app).get(`/api/v1/machines/${machineId}`).set(admin.auth);
    return String(res.body.data.status);
  };

  it('a technician cannot PATCH a machine (including its status)', async () => {
    const res = await request(ctx.app)
      .patch(`/api/v1/machines/${machineId}`)
      .set(tech.auth)
      .send({ status: 'DOWNTIME' })
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(await currentStatus()).toBe('ACTIVE');
  });

  it('even an administrator cannot set status through the machine endpoint', async () => {
    const res = await request(ctx.app)
      .patch(`/api/v1/machines/${machineId}`)
      .set(admin.auth)
      .send({ name: 'Press 1', status: 'DOWNTIME' })
      .expect(400);
    expect(res.body.details).toContainEqual({ field: 'status', message: 'is not allowed' });
    expect(await currentStatus()).toBe('ACTIVE');
  });

  it('status supplied at creation is rejected, so machines always start ACTIVE', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/machines')
      .set(admin.auth)
      .send({ name: 'Press 2', serialNumber: 'PRS-002', status: 'UNDER_TEST' })
      .expect(400);
    expect(res.body.details).toContainEqual({ field: 'status', message: 'is not allowed' });
  });

  it.each([
    ['put', () => `/api/v1/machines/${machineId}`],
    ['put', () => `/api/v1/machines/${machineId}/status`],
    ['patch', () => `/api/v1/machines/${machineId}/status`],
    ['post', () => `/api/v1/machines/${machineId}/status`],
  ] as const)('there is no %s status endpoint', async (method, path) => {
    await request(ctx.app)[method](path()).set(tech.auth).send({ status: 'DOWNTIME' }).expect(404);
    expect(await currentStatus()).toBe('ACTIVE');
  });

  it.each([
    ['post', '/api/v1/machines'],
    ['post', () => `/api/v1/machines/${machineId}/deactivate`],
    ['post', () => `/api/v1/machines/${machineId}/activate`],
    ['delete', () => `/api/v1/machines/${machineId}`],
  ] as const)('technician is forbidden from %s %s', async (method, path) => {
    const url = typeof path === 'function' ? path() : path;
    const res = await request(ctx.app)
      [method](url)
      .set(tech.auth)
      .send({ name: 'x', serialNumber: 'X-1' })
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});
