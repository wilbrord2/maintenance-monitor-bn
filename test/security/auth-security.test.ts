import jwt from 'jsonwebtoken';
import request from 'supertest';
import { AuditLog } from '../../src/audit/audit-log.entity';
import { RefreshToken } from '../../src/auth/entities/refresh-token.entity';
import { Role } from '../../src/common/enums/role.enum';
import { adminSession, createSession, createUser, login, technicianSession } from '../helpers/factories';
import { createTestContext, resetDatabase, type TestContext } from '../helpers/test-app';

describe('Security: authentication & authorization', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.container.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.container);
  });

  describe('unauthorized access', () => {
    it.each([
      ['get', '/api/v1/users'],
      ['get', '/api/v1/users/me'],
      ['post', '/api/v1/users'],
      ['post', '/api/v1/auth/logout'],
      ['post', '/api/v1/auth/change-password'],
    ] as const)('%s %s requires authentication', async (method, path) => {
      const res = await request(ctx.app)[method](path).send({}).expect(401);
      expect(res.body).toMatchObject({ success: false, code: 'UNAUTHORIZED' });
    });

    it('rejects malformed authorization headers', async () => {
      for (const header of ['Bearer', 'Basic abc', 'Bearer a b', 'bearer not.a.jwt']) {
        const res = await request(ctx.app).get('/api/v1/users/me').set('Authorization', header);
        expect(res.status).toBe(401);
      }
    });
  });

  describe('JWT validation', () => {
    it('rejects an expired access token', async () => {
      const session = await technicianSession(ctx);
      const expired = jwt.sign(
        {
          sub: session.user.id,
          userId: session.user.id,
          name: 'x',
          role: 'TECHNICIAN',
          phone: '0780000000',
          type: 'access',
          sid: '00000000-0000-4000-8000-000000000000',
          iat: Math.floor(Date.now() / 1000) - 3600,
        },
        ctx.config.jwt.accessSecret,
        {
          algorithm: 'HS256',
          expiresIn: 60,
          issuer: ctx.config.jwt.issuer,
          audience: ctx.config.jwt.audience,
        },
      );
      const res = await request(ctx.app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${expired}`)
        .expect(401);
      expect(res.body.code).toBe('TOKEN_EXPIRED');
    });

    it('rejects tokens signed with another secret, the "none" algorithm, or a refresh token', async () => {
      const session = await technicianSession(ctx);
      const [, payload] = session.accessToken.split('.');
      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));

      const forged = jwt.sign(claims, 'attacker-controlled-secret-attacker-controlled', {
        algorithm: 'HS256',
      });
      const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${payload}.`;

      for (const token of [forged, unsigned, session.refreshToken]) {
        const res = await request(ctx.app)
          .get('/api/v1/users/me')
          .set('Authorization', `Bearer ${token}`)
          .expect(401);
        expect(res.body.code).toBe('TOKEN_INVALID');
      }
    });

    it('rejects a token whose role claim was tampered with', async () => {
      const session = await technicianSession(ctx);
      const [header, payload, signature] = session.accessToken.split('.');
      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
      const tampered = `${header}.${Buffer.from(JSON.stringify({ ...claims, role: 'ADMIN' })).toString('base64url')}.${signature}`;
      await request(ctx.app).get('/api/v1/users').set('Authorization', `Bearer ${tampered}`).expect(401);
    });
  });

  describe('refresh token revocation', () => {
    it('rejects a revoked refresh token', async () => {
      const session = await technicianSession(ctx);
      await request(ctx.app).post('/api/v1/auth/logout').set(session.auth).expect(200);
      const res = await request(ctx.app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
      expect(res.body.code).toBe('TOKEN_REVOKED');
    });

    it('detects refresh token reuse and revokes the whole session family', async () => {
      const session = await technicianSession(ctx);
      const rotated = await request(ctx.app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(200);

      // An attacker replays the original (already rotated) token.
      const replay = await request(ctx.app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
      expect(replay.body.code).toBe('TOKEN_REVOKED');

      // The legitimate holder's newer tokens are now revoked too.
      await request(ctx.app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: rotated.body.data.tokens.refreshToken })
        .expect(401);
      await request(ctx.app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${rotated.body.data.tokens.accessToken}`)
        .expect(401);

      const reasons = (await ctx.container.dataSource.getRepository(RefreshToken).find()).map(
        (t) => t.revokedReason,
      );
      expect(reasons).toContain('REUSE_DETECTED');
      expect(
        await ctx.container.dataSource.getRepository(AuditLog).countBy({ action: 'TOKEN_REUSE_DETECTED' }),
      ).toBe(1);
    });

    it('rejects an expired refresh token', async () => {
      const session = await technicianSession(ctx);
      await ctx.container.dataSource.query(
        `UPDATE refresh_tokens SET expires_at = now() - interval '1 second'`,
      );
      const res = await request(ctx.app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
      expect(res.body.code).toBe('TOKEN_EXPIRED');
    });

    it('rejects a structurally valid refresh token that was never issued', async () => {
      const user = await createUser(ctx);
      const fake = jwt.sign(
        {
          sub: user.id,
          type: 'refresh',
          sid: '00000000-0000-4000-8000-000000000001',
          jti: '00000000-0000-4000-8000-000000000002',
        },
        ctx.config.jwt.refreshSecret,
        {
          algorithm: 'HS256',
          expiresIn: 3600,
          issuer: ctx.config.jwt.issuer,
          audience: ctx.config.jwt.audience,
        },
      );
      const res = await request(ctx.app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: fake })
        .expect(401);
      expect(res.body.code).toBe('TOKEN_INVALID');
    });
  });

  describe('inactive users', () => {
    it('cannot log in, and existing sessions stop working', async () => {
      const session = await technicianSession(ctx);
      await ctx.container.dataSource.query('UPDATE users SET is_active = false WHERE id = $1', [
        session.user.id,
      ]);

      await request(ctx.app).get('/api/v1/users/me').set(session.auth).expect(401);
      await request(ctx.app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
      const res = await login(ctx, session.user.email).expect(403);
      expect(res.body.code).toBe('USER_INACTIVE');
    });

    it('a deactivated user with a wrong password gets the generic credentials error', async () => {
      const user = await createUser(ctx, { isActive: false });
      const res = await login(ctx, user.email, 'Wrong-Password-99').expect(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('brute-force protection', () => {
    it('locks the account after the configured number of failures, even for the right password', async () => {
      const user = await createUser(ctx);
      for (let i = 0; i < ctx.config.auth.maxLoginAttempts; i += 1) {
        await login(ctx, user.email, `Wrong-Password-${i}`).expect(401);
      }
      const locked = await login(ctx, user.email).expect(423);
      expect(locked.body.code).toBe('ACCOUNT_LOCKED');
      expect(
        await ctx.container.dataSource.getRepository(AuditLog).countBy({ action: 'ACCOUNT_LOCKED' }),
      ).toBe(1);

      // Once the lock expires the correct password works and the counter resets.
      await ctx.container.dataSource.query(
        `UPDATE users SET locked_until = now() - interval '1 second' WHERE id = $1`,
        [user.id],
      );
      await login(ctx, user.email).expect(200);
    });

    it('counts concurrent failures atomically', async () => {
      const user = await createUser(ctx);
      const attempts = ctx.config.auth.maxLoginAttempts;
      await Promise.all(
        Array.from({ length: attempts }, (_, i) => login(ctx, user.email, `Wrong-Password-${i}`)),
      );
      await login(ctx, user.email).expect(423);
    });

    it('rate limits login requests per IP and account', async () => {
      const limited = await createTestContext({ env: { AUTH_RATE_LIMIT_MAX: '3' } });
      try {
        for (let i = 0; i < 3; i += 1)
          await login(limited, 'someone@example.test', 'Wrong-Password-1').expect(401);
        const res = await login(limited, 'someone@example.test', 'Wrong-Password-1').expect(429);
        expect(res.body.code).toBe('RATE_LIMITED');
        expect(res.headers.ratelimit).toBeDefined();
      } finally {
        await limited.container.close();
      }
    });
  });

  describe('role violations', () => {
    it.each([
      ['get', '/api/v1/users'],
      ['post', '/api/v1/users'],
      ['get', '/api/v1/users/1'],
      ['patch', '/api/v1/users/1'],
      ['post', '/api/v1/users/1/deactivate'],
      ['delete', '/api/v1/users/1'],
    ] as const)('technician is forbidden from %s %s', async (method, path) => {
      const tech = await technicianSession(ctx);
      const res = await request(ctx.app)
        [method](path)
        .set(tech.auth)
        .send({ fullName: 'Hacker Name' })
        .expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('authorization is resolved from the database, not only the token', async () => {
      const session = await createSession(ctx, { role: Role.ADMIN });
      await ctx.container.dataSource.query(`UPDATE users SET role = 'TECHNICIAN' WHERE id = $1`, [
        session.user.id,
      ]);
      await request(ctx.app).get('/api/v1/users').set(session.auth).expect(403);
    });

    it('does not leak stack traces or SQL in errors', async () => {
      const admin = await adminSession(ctx);
      const res = await request(ctx.app).get('/api/v1/users/2147483648').set(admin.auth).expect(400);
      expect(JSON.stringify(res.body)).not.toMatch(/stack|QueryFailedError|SELECT|at \w+ \(/);
    });
  });
});
