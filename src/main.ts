import 'reflect-metadata';
import 'dotenv/config';
import { createServer } from 'node:http';
import { createApp } from './app';
import { createLogger } from './common/logger/logger';
import { loadConfig } from './config/config';
import { createContainer } from './container';

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const container = await createContainer(config);
  const { logger } = container;

  const app = createApp(container);
  const server = createServer(app);
  server.headersTimeout = 65_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 61_000;
  container.statusBoard.attach(server);

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  container.tokenCleanup.start();
  logger.info(
    { port: config.port, env: config.env, version: container.version },
    'Maintenance Monitor API started',
  );

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    // Stop accepting connections, let in-flight requests finish, then release resources.
    const httpClosed = new Promise<void>((resolve) => {
      server.close((error) => {
        if (error) logger.warn({ err: error }, 'HTTP server was not running');
        resolve();
      });
    });
    server.closeIdleConnections();

    // WebSocket connections would otherwise keep the HTTP server open.
    container.statusBoard
      .close()
      .then(() => httpClosed)
      .then(() => container.close())
      .then(() => {
        logger.info('Shutdown complete');
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'Error during shutdown');
        process.exit(1);
      });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });
}

bootstrap().catch((error: unknown) => {
  // Configuration errors list variable names only, never values.
  createLogger({ level: 'error' }).fatal({ err: error }, 'Failed to start Maintenance Monitor API');
  process.exit(1);
});
