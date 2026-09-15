import { type Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { type AuthenticatedUser } from '../../auth/auth.types';
import { extractBearerToken } from '../../auth/guards/authenticate.guard';
import { type SessionService } from '../../auth/session.service';
import { AppError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { type DomainEventBus } from '../../common/events/domain-event-bus';
import { MACHINE_STATUS_UPDATED, type MachineStatusUpdatedEvent } from '../../common/events/domain-events';
import { type AppLogger } from '../../common/logger/logger';
import { type AppConfig } from '../../config/config';

export const STATUS_BOARD_NAMESPACE = '/status-board';
export const STATUS_BOARD_ROOM = 'fleet';
export const SOCKET_PATH = '/socket.io';

/** Largest delay accepted by setTimeout (~24.8 days). */
const MAX_TIMER_MS = 2_147_483_647;

interface ServerToClientEvents {
  [MACHINE_STATUS_UPDATED]: (payload: MachineStatusUpdatedEvent) => void;
  'session.expired': (payload: { reason: 'ACCESS_TOKEN_EXPIRED' }) => void;
}

type ClientToServerEvents = Record<string, never>;

interface SocketData {
  user: AuthenticatedUser;
}

type BoardSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/**
 * Live status board over Socket.IO.
 *
 * Clients connect to the `/status-board` namespace with an access token in the
 * handshake (`auth: { token }`, or an `Authorization: Bearer` header). The
 * token and its session are verified like any HTTP request, and the socket is
 * disconnected when the token expires so revoked sessions cannot keep
 * listening; clients reconnect with a refreshed token.
 *
 * Broadcasts happen after the database transaction commits. For several API
 * replicas, install the Socket.IO Redis adapter on `server` so every replica's
 * clients receive every event.
 */
export class StatusBoardGateway {
  private server: Server<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  > | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly sessions: SessionService,
    private readonly events: DomainEventBus,
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
  ) {}

  attach(httpServer: HttpServer): void {
    if (this.server) throw new Error('Status board gateway is already attached');

    const server = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(
      httpServer,
      {
        path: SOCKET_PATH,
        serveClient: false,
        cors: { origin: [...this.config.corsOrigins], credentials: true },
        maxHttpBufferSize: 10_000,
        pingInterval: 25_000,
        pingTimeout: 20_000,
      },
    );
    const board = server.of(STATUS_BOARD_NAMESPACE);

    board.use((socket, next) => {
      this.authenticate(socket)
        .then(() => {
          next();
        })
        .catch((error: unknown) => {
          const code = error instanceof AppError ? error.code : ErrorCode.UNAUTHORIZED;
          next(Object.assign(new Error(code), { data: { code } }));
        });
    });

    board.on('connection', (socket: BoardSocket) => {
      void socket.join(STATUS_BOARD_ROOM);
      this.logger.info({ userId: socket.data.user.id }, 'Status board client connected');
      socket.on('disconnect', (reason) => {
        this.logger.info({ userId: socket.data.user.id, reason }, 'Status board client disconnected');
      });
    });

    // Namespace (not server) root: dashboards connect to `/status-board` only.
    server.of('/').use((_socket, next) => {
      next(new Error(ErrorCode.ROUTE_NOT_FOUND));
    });

    this.unsubscribe = this.events.subscribe(MACHINE_STATUS_UPDATED, (event) => {
      board.to(STATUS_BOARD_ROOM).emit(MACHINE_STATUS_UPDATED, event);
    });
    this.server = server;
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const server = this.server;
    this.server = null;
    if (server) await server.close();
  }

  private async authenticate(socket: BoardSocket): Promise<void> {
    const auth: unknown = socket.handshake.auth;
    const fromAuth =
      typeof auth === 'object' && auth !== null && 'token' in auth && typeof auth.token === 'string'
        ? auth.token
        : null;
    const token = fromAuth ?? extractBearerToken(socket.handshake.headers.authorization);
    if (!token) throw AppError.unauthorized();

    const { user, expiresAt } = await this.sessions.authenticateWithExpiry(token);
    if (user.mustChangePassword) {
      throw AppError.forbidden('Password change required', ErrorCode.PASSWORD_CHANGE_REQUIRED);
    }
    socket.data.user = user;

    const timer = setTimeout(
      () => {
        socket.emit('session.expired', { reason: 'ACCESS_TOKEN_EXPIRED' });
        socket.disconnect(true);
      },
      Math.min(Math.max(expiresAt.getTime() - Date.now(), 0), MAX_TIMER_MS),
    );
    timer.unref();
    socket.on('disconnect', () => {
      clearTimeout(timer);
    });
  }
}
