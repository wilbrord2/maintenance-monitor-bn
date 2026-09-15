import request from 'supertest';
import { createTestContext, type TestContext } from '../helpers/test-app';

describe('Health & platform', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.container.close();
  });

  afterEach(() => {
    ctx.mail.clear();
  });

  it('reports healthy application, database and email', async () => {
    const res = await request(ctx.app).get('/api/v1/health').expect(200);
    expect(res.body).toMatchObject({
      success: true,
      data: {
        status: 'ok',
        checks: { application: { status: 'up' }, database: { status: 'up' }, email: { status: 'up' } },
      },
    });
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('reports degraded when the mail server is unreachable', async () => {
    const fresh = await createTestContext();
    fresh.mail.failVerify = true;
    try {
      const res = await request(fresh.app).get('/api/v1/health').expect(200);
      expect(res.body.data.status).toBe('degraded');
      expect(res.body.data.checks.email).toEqual(
        expect.objectContaining({ status: 'down', error: 'Mail server unreachable' }),
      );
    } finally {
      await fresh.container.close();
    }
  });

  it('propagates a well-formed X-Request-Id and replaces malformed ones', async () => {
    const good = await request(ctx.app).get('/api/v1/health/live').set('X-Request-Id', 'client-req-12345');
    expect(good.headers['x-request-id']).toBe('client-req-12345');

    const bad = await request(ctx.app).get('/api/v1/health/live').set('X-Request-Id', 'bad id <script>');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the standard error envelope for unknown routes', async () => {
    const res = await request(ctx.app).get('/api/v1/does-not-exist').expect(404);
    expect(res.body).toEqual({
      success: false,
      message: 'Route GET /api/v1/does-not-exist not found',
      code: 'ROUTE_NOT_FOUND',
      timestamp: expect.any(String),
      path: '/api/v1/does-not-exist',
      requestId: expect.any(String),
    });
  });

  it('rejects malformed JSON without leaking parser internals', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":')
      .expect(400);
    expect(res.body).toMatchObject({
      success: false,
      code: 'BAD_REQUEST',
      message: 'Malformed JSON request body',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/stack|SyntaxError/);
  });

  it('rejects oversized request bodies', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(200_000) }))
      .expect(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('sets secure headers and hides the framework', async () => {
    const res = await request(ctx.app).get('/api/v1/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('only allows configured CORS origins', async () => {
    const allowed = await request(ctx.app).get('/api/v1/health/live').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    const denied = await request(ctx.app)
      .get('/api/v1/health/live')
      .set('Origin', 'https://evil.example')
      .expect(403);
    expect(denied.body.code).toBe('CORS_ORIGIN_DENIED');
  });

  it('serves the OpenAPI document', async () => {
    const res = await request(ctx.app).get('/api/docs/openapi.json').expect(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.paths['/api/v1/health']).toBeDefined();
  });
});
