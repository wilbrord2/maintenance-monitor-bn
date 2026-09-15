import request from 'supertest';
import { AuditLog } from '../../src/audit/audit-log.entity';
import { User } from '../../src/users/user.entity';
import { adminSession, createUser, login, technicianSession } from '../helpers/factories';
import { createTestContext, resetDatabase, type TestContext } from '../helpers/test-app';

describe('Users', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.container.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.container);
    ctx.mail.clear();
  });

  const newTechnician = {
    fullName: 'Alice Fixer',
    email: 'alice@example.test',
    phone: '0781234567',
    position: 'Mechanic',
  };

  describe('POST /users (create technician)', () => {
    it('rejects duplicate email and phone with specific codes', async () => {
      const admin = await adminSession(ctx);
      await request(ctx.app).post('/api/v1/users').set(admin.auth).send(newTechnician).expect(201);

      const dupEmail = await request(ctx.app)
        .post('/api/v1/users')
        .set(admin.auth)
        .send({ ...newTechnician, phone: '0789999999', email: 'ALICE@example.test' })
        .expect(409);
      expect(dupEmail.body.code).toBe('USER_EMAIL_EXISTS');

      const dupPhone = await request(ctx.app)
        .post('/api/v1/users')
        .set(admin.auth)
        .send({ ...newTechnician, email: 'other@example.test' })
        .expect(409);
      expect(dupPhone.body.code).toBe('USER_PHONE_EXISTS');
    });

    it('rejects unknown fields such as role escalation attempts', async () => {
      const admin = await adminSession(ctx);
      const res = await request(ctx.app)
        .post('/api/v1/users')
        .set(admin.auth)
        .send({ ...newTechnician, role: 'ADMIN' })
        .expect(400);
      expect(res.body.details).toContainEqual({ field: 'role', message: 'is not allowed' });
    });

    it('validates phone and name formats', async () => {
      const admin = await adminSession(ctx);
      const res = await request(ctx.app)
        .post('/api/v1/users')
        .set(admin.auth)
        .send({ fullName: ' ', email: 'x@example.test', phone: '12-34' })
        .expect(400);
      const fields = (res.body.details as { field: string }[]).map((d) => d.field);
      expect(fields).toEqual(expect.arrayContaining(['fullName', 'phone']));
    });
  });

  describe('GET /users', () => {
    it('paginates, filters and searches', async () => {
      const admin = await adminSession(ctx);
      for (let i = 0; i < 5; i += 1) await createUser(ctx, { fullName: `Tech ${i}` });
      await createUser(ctx, { fullName: 'Dormant Dan', isActive: false });

      const page = await request(ctx.app)
        .get('/api/v1/users?page=2&limit=2&sortBy=fullName&sortOrder=asc')
        .set(admin.auth)
        .expect(200);
      expect(page.body.data).toHaveLength(2);
      expect(page.body.meta).toEqual({ page: 2, limit: 2, totalItems: 7, totalPages: 4 });

      const inactive = await request(ctx.app).get('/api/v1/users?isActive=false').set(admin.auth).expect(200);
      expect(inactive.body.data.map((u: { fullName: string }) => u.fullName)).toEqual(['Dormant Dan']);

      const search = await request(ctx.app).get('/api/v1/users?search=dormant').set(admin.auth).expect(200);
      expect(search.body.meta.totalItems).toBe(1);

      const wildcard = await request(ctx.app).get('/api/v1/users?search=%25').set(admin.auth).expect(200);
      expect(wildcard.body.meta.totalItems).toBe(0);
    });

    it('caps the page size', async () => {
      const admin = await adminSession(ctx);
      const res = await request(ctx.app).get('/api/v1/users?limit=1000').set(admin.auth).expect(400);
      expect(res.body.details[0].field).toBe('query.limit');
    });
  });

  describe('PATCH /users/:id', () => {
    it('updates fields and records old/new values in the audit log', async () => {
      const admin = await adminSession(ctx);
      const tech = await createUser(ctx, { fullName: 'Before Name' });

      const res = await request(ctx.app)
        .patch(`/api/v1/users/${tech.id}`)
        .set(admin.auth)
        .send({ fullName: 'After Name', position: null })
        .expect(200);
      expect(res.body.data).toMatchObject({ fullName: 'After Name', position: null });

      const audit = await ctx.container.dataSource
        .getRepository(AuditLog)
        .findOneByOrFail({ action: 'USER_UPDATED' });
      expect(audit).toMatchObject({
        userId: admin.user.id,
        entity: 'USER',
        entityId: String(tech.id),
        oldValues: { fullName: 'Before Name', position: 'Technician' },
        newValues: { fullName: 'After Name', position: null },
      });
    });

    it('returns 404 for unknown users and 400 for invalid ids', async () => {
      const admin = await adminSession(ctx);
      const missing = await request(ctx.app)
        .patch('/api/v1/users/99999')
        .set(admin.auth)
        .send({ fullName: 'X Y' })
        .expect(404);
      expect(missing.body.code).toBe('USER_NOT_FOUND');
      const invalid = await request(ctx.app)
        .patch('/api/v1/users/abc')
        .set(admin.auth)
        .send({ fullName: 'X Y' })
        .expect(400);
      expect(invalid.body.details).toEqual([{ field: 'params.id', message: 'must be a positive integer' }]);
    });
  });

  describe('deactivation and deletion', () => {
    it('deactivating a user revokes their sessions and blocks login', async () => {
      const admin = await adminSession(ctx);
      const tech = await technicianSession(ctx);

      await request(ctx.app).post(`/api/v1/users/${tech.user.id}/deactivate`).set(admin.auth).expect(200);
      await request(ctx.app).get('/api/v1/users/me').set(tech.auth).expect(401);
      const res = await login(ctx, tech.user.email).expect(403);
      expect(res.body.code).toBe('USER_INACTIVE');

      await request(ctx.app).post(`/api/v1/users/${tech.user.id}/activate`).set(admin.auth).expect(200);
      await login(ctx, tech.user.email).expect(200);
    });

    it('prevents administrators from deactivating or deleting themselves', async () => {
      const admin = await adminSession(ctx);
      const res = await request(ctx.app)
        .post(`/api/v1/users/${admin.user.id}/deactivate`)
        .set(admin.auth)
        .expect(403);
      expect(res.body.code).toBe('USER_SELF_MODIFICATION_FORBIDDEN');
      await request(ctx.app).delete(`/api/v1/users/${admin.user.id}`).set(admin.auth).expect(403);
    });

    it('soft-deletes users while keeping the row for history', async () => {
      const admin = await adminSession(ctx);
      const tech = await createUser(ctx);
      await request(ctx.app).delete(`/api/v1/users/${tech.id}`).set(admin.auth).expect(200);
      await request(ctx.app).get(`/api/v1/users/${tech.id}`).set(admin.auth).expect(404);

      const row = await ctx.container.dataSource
        .getRepository(User)
        .findOne({ where: { id: tech.id }, withDeleted: true });
      expect(row?.deletedAt).toBeInstanceOf(Date);
      expect(row?.isActive).toBe(false);
    });
  });

  describe('POST /users/:id/reissue-temporary-password', () => {
    it('issues a new temporary credential and revokes existing sessions', async () => {
      const admin = await adminSession(ctx);
      const tech = await technicianSession(ctx);

      const res = await request(ctx.app)
        .post(`/api/v1/users/${tech.user.id}/reissue-temporary-password`)
        .set(admin.auth)
        .expect(200);
      expect(res.body.data.mustChangePassword).toBe(true);
      expect(ctx.mail.lastTo(tech.user.email)?.text).toMatch(/Temporary password: \S+/);
      await request(ctx.app).get('/api/v1/users/me').set(tech.auth).expect(401);
    });

    it('refuses to issue temporary passwords to administrators', async () => {
      const admin = await adminSession(ctx);
      const other = await adminSession(ctx);
      const res = await request(ctx.app)
        .post(`/api/v1/users/${other.user.id}/reissue-temporary-password`)
        .set(admin.auth)
        .expect(422);
      expect(res.body.code).toBe('USER_NOT_TECHNICIAN');
    });
  });

  describe('own profile', () => {
    it('lets a technician update name and phone but not email or role', async () => {
      const tech = await technicianSession(ctx);
      await request(ctx.app)
        .patch('/api/v1/users/me')
        .set(tech.auth)
        .send({ fullName: 'New Name', phone: '0799000111' })
        .expect(200);
      const res = await request(ctx.app)
        .patch('/api/v1/users/me')
        .set(tech.auth)
        .send({ email: 'x@example.test', role: 'ADMIN' })
        .expect(400);
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          { field: 'email', message: 'is not allowed' },
          { field: 'role', message: 'is not allowed' },
        ]),
      );
    });
  });
});
