import 'reflect-metadata';
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { createLogger } from '../../common/logger/logger';
import { loadConfig } from '../../config/config';
import { buildDataSourceOptions } from '../data-source.options';

type Command = 'run' | 'revert' | 'show';

function parseCommand(value: string | undefined): Command {
  if (value === 'run' || value === 'revert' || value === 'show') return value;
  throw new Error('Usage: migrate <run|revert|show>');
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const dataSource = new DataSource(buildDataSourceOptions(config));
  await dataSource.initialize();

  try {
    if (command === 'run') {
      const applied = await dataSource.runMigrations({ transaction: 'each' });
      logger.info({ migrations: applied.map((m) => m.name) }, `Applied ${applied.length} migration(s)`);
    } else if (command === 'revert') {
      await dataSource.undoLastMigration({ transaction: 'each' });
      logger.info('Reverted the last migration');
    } else {
      const pending = await dataSource.showMigrations();
      logger.info({ pending }, pending ? 'There are pending migrations' : 'Schema is up to date');
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  const logger = createLogger({ level: 'error' });
  logger.error({ err: error }, 'Migration command failed');
  process.exitCode = 1;
});
