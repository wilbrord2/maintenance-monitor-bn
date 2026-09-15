import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import {
  MACHINE_STATUS_UPDATED,
  type MachineStatusUpdatedEvent,
} from '../../src/common/events/domain-events';
import {
  adminSession,
  createMachine,
  createSession,
  technicianSession,
  type Session,
} from '../helpers/factories';
import { createTestContext, resetDatabase, type TestContext } from '../helpers/test-app';

describe('Live status board (Socket.IO)', () => {
  let ctx: TestContext;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.container.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.container);
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.disconnect();
  });

  function connect(auth: Record<string, unknown> = {}): Socket {
    const socket = io(`${ctx.baseUrl}/status-board`, {
      path: '/socket.io',
      auth,
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    return socket;
  }

  const connected = (socket: Socket) =>
    new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', (error) => reject(error));
    });

  const rejected = (socket: Socket) =>
    new Promise<Error & { data?: { code?: string } }>((resolve, reject) => {
      socket.once('connect', () => reject(new Error('connection unexpectedly accepted')));
      socket.once('connect_error', (error) => resolve(error));
    });

  const nextEvent = (socket: Socket, timeoutMs = 5000) =>
    new Promise<MachineStatusUpdatedEvent>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for machine.status.updated')),
        timeoutMs,
      );
      socket.once(MACHINE_STATUS_UPDATED, (payload: MachineStatusUpdatedEvent) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  it('broadcasts machine.status.updated to every connected dashboard after a log changes status', async () => {
    const tech = await technicianSession(ctx);
    const admin = await adminSession(ctx);
    const machine = await createMachine(ctx, { name: 'Laser 2' });

    const boardA = connect({ token: tech.accessToken });
    const boardB = connect({ token: admin.accessToken });
    await Promise.all([connected(boardA), connected(boardB)]);
    const received = Promise.all([nextEvent(boardA), nextEvent(boardB)]);

    const log = await request(ctx.app)
      .post('/api/v1/machine-logs')
      .set(tech.auth)
      .send({
        machineId: machine.id,
        faultDescription: 'Lens dirty',
        entryStatus: 'ACTIVE',
        resultingState: 'UNDER_MAINTENANCE',
      })
      .expect(201);

    const [eventA, eventB] = await received;
    expect(eventA).toEqual({
      machineId: machine.id,
      machineName: 'Laser 2',
      serialNumber: machine.serialNumber,
      previousStatus: 'ACTIVE',
      newStatus: 'UNDER_MAINTENANCE',
      updatedBy: { id: tech.user.id, name: tech.user.fullName },
      logId: log.body.data.id,
      source: 'MACHINE_LOG_CREATED',
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(eventB).toEqual(eventA);
  });

  it('does not broadcast when a request fails or leaves the status unchanged', async () => {
    const tech = await technicianSession(ctx);
    const machine = await createMachine(ctx);
    const board = connect({ token: tech.accessToken });
    await connected(board);

    const events: unknown[] = [];
    board.on(MACHINE_STATUS_UPDATED, (payload) => events.push(payload));

    await request(ctx.app)
      .post('/api/v1/machine-logs')
      .set(tech.auth)
      .send({
        machineId: machine.id,
        faultDescription: 'Stale',
        entryStatus: 'DOWNTIME',
        resultingState: 'ACTIVE',
      })
      .expect(409);
    await request(ctx.app)
      .post('/api/v1/machine-logs')
      .set(tech.auth)
      .send({
        machineId: machine.id,
        faultDescription: 'Inspection',
        entryStatus: 'ACTIVE',
        resultingState: 'ACTIVE',
      })
      .expect(201);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(events).toHaveLength(0);
  });

  it('accepts the token from an Authorization header', async () => {
    const tech = await technicianSession(ctx);
    const socket = io(`${ctx.baseUrl}/status-board`, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      extraHeaders: { Authorization: `Bearer ${tech.accessToken}` },
    });
    sockets.push(socket);
    await connected(socket);
  });

  it('rejects connections without a valid, live session', async () => {
    const missing = await rejected(connect());
    expect(missing.message).toBe('UNAUTHORIZED');

    const invalid = await rejected(connect({ token: 'not-a-jwt' }));
    expect(invalid.message).toBe('TOKEN_INVALID');

    const session: Session = await technicianSession(ctx);
    await request(ctx.app).post('/api/v1/auth/logout').set(session.auth).expect(200);
    const revoked = await rejected(connect({ token: session.accessToken }));
    expect(revoked.message).toBe('TOKEN_REVOKED');
  });

  it('rejects users who still have to change a temporary password', async () => {
    const pending = await createSession(ctx, {
      mustChangePassword: true,
      passwordExpiresAt: new Date(Date.now() + 3_600_000),
    });
    const error = await rejected(connect({ token: pending.accessToken }));
    expect(error.message).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('disconnects a dashboard when its access token expires', async () => {
    const shortLived = await createTestContext({ env: { JWT_ACCESS_EXPIRES_IN: '2s' } });
    try {
      const session = await technicianSession(shortLived);
      const socket = io(`${shortLived.baseUrl}/status-board`, {
        path: '/socket.io',
        auth: { token: session.accessToken },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      sockets.push(socket);
      await connected(socket);

      const expired = new Promise<{ reason: string }>((resolve) => socket.once('session.expired', resolve));
      const disconnected = new Promise<string>((resolve) => socket.once('disconnect', resolve));
      await expect(expired).resolves.toEqual({ reason: 'ACCESS_TOKEN_EXPIRED' });
      await expect(disconnected).resolves.toBe('io server disconnect');
    } finally {
      await shortLived.container.close();
    }
  });

  it('refuses the root namespace', async () => {
    const tech = await technicianSession(ctx);
    const socket = io(ctx.baseUrl, {
      path: '/socket.io',
      auth: { token: tech.accessToken },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    const error = await rejected(socket);
    expect(error.message).toBe('ROUTE_NOT_FOUND');
  });
});
