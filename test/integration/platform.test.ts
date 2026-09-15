import request from 'supertest';
import { Argon2PasswordHasher } from '../../src/auth/password-hasher';
import { seedAdmin } from '../../src/database/seeds/admin.seed';
import { User } from '../../src/users/user.entity';
import { login } from '../helpers/factories';
import { createTestContext, resetDatabase, type TestContext } from '../helpers/test-app';

describe('Platform: seed, Swagger protection and OpenAPI completeness', () => {
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

  describe('admin seed', () => {
    const env = {
      ADMIN_EMAIL: 'Root.Admin@Example.test',
      ADMIN_PASSWORD: 'Seeded-Admin-Passw0rd',
      ADMIN_NAME: 'Root Admin',
      ADMIN_PHONE: '0780000999',
    };

    it('creates an ADMIN with a hashed password, idempotently', async () => {
      const hasher = new Argon2PasswordHasher(ctx.config.argon2);
      await expect(seedAdmin(ctx.container.dataSource, hasher, env)).resolves.toBe('created');
      await expect(seedAdmin(ctx.container.dataSource, hasher, env)).resolves.toBe('exists');

      const admins = await ctx.container.dataSource.getRepository(User).find();
      expect(admins).toHaveLength(1);
      expect(admins[0]).toMatchObject({
        email: 'root.admin@example.test',
        role: 'ADMIN',
        mustChangePassword: false,
      });
      expect(admins[0]!.passwordHash).toMatch(/^\$argon2id\$/);
      expect(admins[0]!.passwordHash).not.toContain(env.ADMIN_PASSWORD);

      await login(ctx, 'root.admin@example.test', env.ADMIN_PASSWORD).expect(200);
    });

    it('refuses weak or missing configuration without echoing secrets', async () => {
      const hasher = new Argon2PasswordHasher(ctx.config.argon2);
      const attempt = seedAdmin(ctx.container.dataSource, hasher, { ...env, ADMIN_PASSWORD: 'weakpass' });
      await expect(attempt).rejects.toThrow(/ADMIN_PASSWORD/);
      await expect(attempt).rejects.not.toThrow(/weakpass/);
      await expect(seedAdmin(ctx.container.dataSource, hasher, {})).rejects.toThrow(/ADMIN_EMAIL/);
    });
  });

  describe('Swagger', () => {
    it('requires basic-auth credentials when configured', async () => {
      const guarded = await createTestContext({
        env: { SWAGGER_ENABLED: 'true', SWAGGER_USERNAME: 'docs', SWAGGER_PASSWORD: 'docs-password-123' },
      });
      try {
        await request(guarded.app)
          .get('/api/docs/openapi.json')
          .expect(401)
          .expect('WWW-Authenticate', /Basic/);
        await request(guarded.app).get('/api/docs/openapi.json').auth('docs', 'wrong-password').expect(401);
        await request(guarded.app)
          .get('/api/docs/openapi.json')
          .auth('docs', 'docs-password-123')
          .expect(200);
        await request(guarded.app).get('/api/docs/').auth('docs', 'docs-password-123').expect(200);
      } finally {
        await guarded.container.close();
      }
    });

    it('is not served when disabled', async () => {
      const disabled = await createTestContext({ env: { SWAGGER_ENABLED: 'false' } });
      try {
        await request(disabled.app).get('/api/docs/openapi.json').expect(404);
      } finally {
        await disabled.container.close();
      }
    });
  });

  describe('OpenAPI document', () => {
    it('documents every mounted route with auth, request schemas and error responses', async () => {
      const res = await request(ctx.app).get('/api/docs/openapi.json').expect(200);
      const paths = res.body.paths as Record<
        string,
        Record<string, { security?: unknown; responses: Record<string, unknown>; requestBody?: unknown }>
      >;

      for (const route of ctx.container.routes) {
        const path = `/api/v1${route.spec.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`;
        const operation = paths[path]?.[route.spec.method];
        expect({ path, method: route.spec.method, documented: operation !== undefined }).toEqual({
          path,
          method: route.spec.method,
          documented: true,
        });
        if (!operation) continue;
        if (route.access.kind === 'protected') {
          expect(operation.security).toEqual([{ bearerAuth: [] }]);
          expect(operation.responses).toHaveProperty('401');
          expect(operation.responses).toHaveProperty('403');
        }
        if (route.spec.body) expect(operation.requestBody).toBeDefined();
        expect(operation.responses).toHaveProperty('500');
      }

      expect(res.body.components.securitySchemes.bearerAuth).toMatchObject({
        type: 'http',
        scheme: 'bearer',
      });
      expect(res.body.components.schemas).toHaveProperty('ErrorResponse');
      expect(res.body.components.schemas).toHaveProperty('MachineLog');
    });
  });
});
