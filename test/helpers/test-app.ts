import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { createApp } from '../../src/app';
import { createLogger } from '../../src/common/logger/logger';
import { type AppConfig, loadConfig } from '../../src/config/config';
import { type Container, type ContainerOverrides, createContainer } from '../../src/container';
import { InMemoryMailTransport } from './in-memory-mail.transport';

export interface TestContext {
  /**
   * A single long-lived HTTP server for the whole suite. Passing an Express app
   * to supertest would start and stop a server per request, which intermittently
   * resets reused keep-alive sockets.
   */
  readonly app: Server;
  readonly baseUrl: string;
  readonly container: Container;
  readonly mail: InMemoryMailTransport;
  readonly config: AppConfig;
}

export async function createTestContext(
  options: { env?: NodeJS.ProcessEnv; overrides?: ContainerOverrides } = {},
): Promise<TestContext> {
  const config = loadConfig({ ...process.env, ...options.env });
  const mail = new InMemoryMailTransport();
  const container = await createContainer(config, {
    logger: createLogger({ level: 'silent' }),
    mailTransport: mail,
    ...options.overrides,
  });

  const server = createServer(createApp(container));
  container.statusBoard.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const closeContainer = container.close.bind(container);
  const testContainer: Container = {
    ...container,
    async close() {
      // Closes Socket.IO (and its HTTP server) before releasing the database.
      await container.statusBoard.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
      await closeContainer();
    },
  };

  return { app: server, baseUrl: `http://127.0.0.1:${port}`, container: testContainer, mail, config };
}

/** Removes all rows between tests while keeping the migrated schema. */
export async function resetDatabase(container: Container): Promise<void> {
  const tables = container.dataSource.entityMetadatas.map((meta) => `"${meta.tableName}"`).join(', ');
  await container.dataSource.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}
