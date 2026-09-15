import request from 'supertest';
import { AuditLog } from '../../src/audit/audit-log.entity';
import { RefreshToken } from '../../src/auth/entities/refresh-token.entity';
import { Role } from '../../src/common/enums/role.enum';
import {
  adminSession,
  createSession,
  createUser,
  flushAsync,
  login,
  resetTokenFrom,
  TEST_PASSWORD,
  temporaryPasswordFrom,
} from '../helpers/factories';
import { createTestContext, resetDatabase, type TestContext } from '../helpers/test-app';

const NEW_PASSWORD = 'Brand-New-Passw0rd';

describe('Authentication', () => {
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

  const auditActions = async () =>
    (await ctx.container.dataSource.getRepository(AuditLog).find({ order: { id: 'ASC' } })).map(
      (a) => a.action,
    );

  describe('POST /auth/login', () => {
    it('returns tokens, user profile and JWT claims without sensitive data', async () => {
      const user = await createUser(ctx, { fullName: 'John Doe', phone: '0780000000' });
      const res = await login(ctx, user.email).expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.user).toMatchObject({ id: user.id, email: user.email, role: 'TECHNICIAN' });
      expect(res.body.data.user).not.toHaveProperty('passwordHash');
      expect(res.body.data.tokens.tokenType).toBe('Bearer');

      const [, payload] = (res.body.data.tokens.accessToken as string).split('.');
      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
      expect(claims).toMatchObject({
        sub: user.id,
        userId: user.id,
        name: 'John Doe',
        role: 'TECHNICIAN',
        phone: '0780000000',
        type: 'access',
      });
      expect(JSON.stringify(claims)).not.toMatch(/password|hash|email/i);

      const cookie = String(res.headers['set-cookie']);
      expect(cookie).toContain('mm_refresh_token=');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/api/v1/auth');

      const stored = await ctx.container.dataSource
        .getRepository(RefreshToken)
        .findOneByOrFail({ userId: user.id });
      expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.tokenHash).not.toBe(res.body.data.tokens.refreshToken);
      expect(await auditActions()).toContain('LOGIN_SUCCEEDED');
    });

    it('is case-insensitive for email', async () => {
      const user = await createUser(ctx);
      await login(ctx, user.email.toUpperCase()).expect(200);
    });

    it('rejects a wrong password and an unknown email with the same response', async () => {
      const user = await createUser(ctx);
      const wrong = await login(ctx, user.email, 'Wrong-Password-123').expect(401);
      const unknown = await login(ctx, 'nobody@example.test', 'Wrong-Password-123').expect(401);
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
      expect(unknown.body.code).toBe('INVALID_CREDENTIALS');
      expect(wrong.body.message).toBe(unknown.body.message);
      expect(await auditActions()).toEqual(['LOGIN_FAILED', 'LOGIN_FAILED']);
    });

    it('validates the request body', async () => {
      const res = await request(ctx.app)
        .post('/api/v1/auth/login')
        .send({ email: 'not-an-email' })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          { field: 'email', message: 'must be a valid email address' },
          expect.objectContaining({ field: 'password' }),
        ]),
      );
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotates the refresh token (body or cookie) and revokes the old one', async () => {
      const session = await createSession(ctx);

      const rotated = await request(ctx.app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(200);
      const newRefresh: string = rotated.body.data.tokens.refreshToken;
      expect(newRefresh).not.toBe(session.refreshToken);

      // Cookie transport works too.
      const viaCookie = await request(ctx.app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', `mm_refresh_token=${newRefresh}`)
        .send({})
        .expect(200);
      expect(viaCookie.body.data.tokens.accessToken).toBeDefined();

      const tokens = await ctx.container.dataSource
        .getRepository(RefreshToken)
        .find({ order: { createdAt: 'ASC' } });
      expect(tokens).toHaveLength(3);
      expect(new Set(tokens.map((t) => t.familyId)).size).toBe(1);
      expect(tokens.filter((t) => t.revokedReason === 'ROTATED')).toHaveLength(2);
    });

    it('requires a refresh token', async () => {
      const res = await request(ctx.app).post('/api/v1/auth/refresh').send({}).expect(401);
      expect(res.body.code).toBe('TOKEN_INVALID');
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes the session so both access and refresh tokens stop working', async () => {
      const session = await createSession(ctx);
      await request(ctx.app).post('/api/v1/auth/logout').set(session.auth).expect(200);

      const me = await request(ctx.app).get('/api/v1/users/me').set(session.auth).expect(401);
      expect(me.body.code).toBe('TOKEN_REVOKED');

      const refresh = await request(ctx.app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
      expect(refresh.body.code).toBe('TOKEN_REVOKED');
      expect(await auditActions()).toContain('LOGOUT');
    });
  });

  describe('first-time technician onboarding', () => {
    it('emails a temporary credential, forces a password change, then invalidates the credential', async () => {
      const admin = await adminSession(ctx);
      const created = await request(ctx.app)
        .post('/api/v1/users')
        .set(admin.auth)
        .send({
          fullName: 'Jane Tech',
          email: 'Jane.Tech@Example.test',
          phone: '0788111222',
          position: 'Electrician',
        })
        .expect(201);

      expect(created.body.data.user).toMatchObject({
        email: 'jane.tech@example.test',
        role: 'TECHNICIAN',
        mustChangePassword: true,
      });
      expect(JSON.stringify(created.body)).not.toMatch(/temporaryPassword|passwordHash/);

      const email = ctx.mail.lastTo('jane.tech@example.test');
      expect(email).toBeDefined();
      const temporaryPassword = temporaryPasswordFrom(email!.text);

      // Login succeeds but the session is restricted until the password changes.
      const loginRes = await login(ctx, 'jane.tech@example.test', temporaryPassword).expect(200);
      expect(loginRes.body.data.mustChangePassword).toBe(true);
      const auth = { Authorization: `Bearer ${loginRes.body.data.tokens.accessToken}` };

      const blocked = await request(ctx.app)
        .patch('/api/v1/users/me')
        .set(auth)
        .send({ fullName: 'Jane T' })
        .expect(403);
      expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
      await request(ctx.app).get('/api/v1/users/me').set(auth).expect(200);

      const changed = await request(ctx.app)
        .post('/api/v1/auth/change-password')
        .set(auth)
        .send({ currentPassword: temporaryPassword, newPassword: NEW_PASSWORD })
        .expect(200);
      expect(changed.body.data.mustChangePassword).toBe(false);

      // Old session is revoked; the new session works; the temporary credential no longer does.
      await request(ctx.app).get('/api/v1/users/me').set(auth).expect(401);
      await request(ctx.app)
        .get('/api/v1/users/me')
        .set({ Authorization: `Bearer ${changed.body.data.tokens.accessToken}` })
        .expect(200);
      await login(ctx, 'jane.tech@example.test', temporaryPassword).expect(401);
      await login(ctx, 'jane.tech@example.test', NEW_PASSWORD).expect(200);

      const actions = await auditActions();
      expect(actions).toEqual(expect.arrayContaining(['TECHNICIAN_CREATED', 'PASSWORD_CHANGED']));
    });

    it('rejects an expired temporary credential', async () => {
      const user = await createUser(ctx, {
        mustChangePassword: true,
        passwordExpiresAt: new Date(Date.now() - 60_000),
      });
      const res = await login(ctx, user.email).expect(401);
      expect(res.body.code).toBe('TEMPORARY_PASSWORD_EXPIRED');
    });

    it('does not create the technician when the credentials email cannot be sent', async () => {
      const admin = await adminSession(ctx);
      ctx.mail.failSend = true;
      const res = await request(ctx.app)
        .post('/api/v1/users')
        .set(admin.auth)
        .send({ fullName: 'No Mail', email: 'nomail@example.test', phone: '0788999000' })
        .expect(503);
      expect(res.body.code).toBe('SERVICE_UNAVAILABLE');
      await login(ctx, 'nomail@example.test', 'Whatever-Passw0rd').expect(401);
      expect(await auditActions()).not.toContain('TECHNICIAN_CREATED');
    });
  });

  describe('POST /auth/change-password', () => {
    it('requires the correct current password and a different, strong new password', async () => {
      const session = await createSession(ctx);

      const wrong = await request(ctx.app)
        .post('/api/v1/auth/change-password')
        .set(session.auth)
        .send({ currentPassword: 'Not-The-Passw0rd', newPassword: NEW_PASSWORD })
        .expect(422);
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');

      const reuse = await request(ctx.app)
        .post('/api/v1/auth/change-password')
        .set(session.auth)
        .send({ currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD })
        .expect(422);
      expect(reuse.body.code).toBe('PASSWORD_REUSE');

      const weak = await request(ctx.app)
        .post('/api/v1/auth/change-password')
        .set(session.auth)
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'short' })
        .expect(400);
      expect(weak.body.details[0].field).toBe('newPassword');
    });

    it('revokes other sessions and notifies by email', async () => {
      const first = await createSession(ctx);
      const second = await login(ctx, first.user.email).expect(200);

      await request(ctx.app)
        .post('/api/v1/auth/change-password')
        .set(first.auth)
        .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })
        .expect(200);
      await flushAsync();

      await request(ctx.app)
        .get('/api/v1/users/me')
        .set({ Authorization: `Bearer ${second.body.data.tokens.accessToken}` })
        .expect(401);
      expect(ctx.mail.lastTo(first.user.email)?.subject).toMatch(/password was changed/);
    });
  });

  describe('password reset', () => {
    it('gives the same response for known and unknown emails and only emails real accounts', async () => {
      const user = await createUser(ctx);
      const known = await request(ctx.app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.email })
        .expect(200);
      const unknown = await request(ctx.app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'ghost@example.test' })
        .expect(200);
      await flushAsync();

      expect(known.body).toEqual(unknown.body);
      expect(ctx.mail.sent).toHaveLength(1);
      expect(ctx.mail.sent[0]!.to).toBe(user.email);
    });

    it('resets the password once, invalidates sessions and requires a new login', async () => {
      const session = await createSession(ctx);
      await request(ctx.app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: session.user.email })
        .expect(200);
      await flushAsync();
      const token = resetTokenFrom(ctx.mail.lastTo(session.user.email)!.text);

      await request(ctx.app)
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: NEW_PASSWORD })
        .expect(200);

      await request(ctx.app).get('/api/v1/users/me').set(session.auth).expect(401);
      await request(ctx.app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
      await login(ctx, session.user.email, TEST_PASSWORD).expect(401);
      await login(ctx, session.user.email, NEW_PASSWORD).expect(200);

      const reused = await request(ctx.app)
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: 'Another-Passw0rd-1' })
        .expect(400);
      expect(reused.body.code).toBe('INVALID_RESET_TOKEN');
      expect(await auditActions()).toEqual(
        expect.arrayContaining(['PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED']),
      );
    });

    it('rejects an expired reset token', async () => {
      const user = await createUser(ctx);
      await request(ctx.app).post('/api/v1/auth/forgot-password').send({ email: user.email }).expect(200);
      await flushAsync();
      const token = resetTokenFrom(ctx.mail.lastTo(user.email)!.text);
      await ctx.container.dataSource.query(
        `UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'`,
      );

      const res = await request(ctx.app)
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: NEW_PASSWORD })
        .expect(400);
      expect(res.body.code).toBe('INVALID_RESET_TOKEN');
    });

    it('only honours the most recent reset link', async () => {
      const user = await createUser(ctx);
      await request(ctx.app).post('/api/v1/auth/forgot-password').send({ email: user.email }).expect(200);
      await flushAsync();
      const first = resetTokenFrom(ctx.mail.lastTo(user.email)!.text);
      await request(ctx.app).post('/api/v1/auth/forgot-password').send({ email: user.email }).expect(200);
      await flushAsync();

      await request(ctx.app)
        .post('/api/v1/auth/reset-password')
        .send({ token: first, newPassword: NEW_PASSWORD })
        .expect(400);
    });
  });

  it('never persists raw credentials in audit logs', async () => {
    const admin = await createSession(ctx, { role: Role.ADMIN });
    await request(ctx.app)
      .post('/api/v1/auth/change-password')
      .set(admin.auth)
      .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })
      .expect(200);
    const rows: unknown[] = await ctx.container.dataSource.query(
      'SELECT old_values, new_values FROM audit_logs',
    );
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(TEST_PASSWORD);
    expect(serialized).not.toContain(NEW_PASSWORD);
    expect(serialized).not.toContain(admin.refreshToken);
  });
});
