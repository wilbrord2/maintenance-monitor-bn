import 'reflect-metadata';
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { Argon2PasswordHasher } from '../../auth/password-hasher';
import { createLogger } from '../../common/logger/logger';
import { loadConfig } from '../../config/config';
import { buildDataSourceOptions } from '../data-source.options';
import { seedAdmin } from '../seeds/admin.seed';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const dataSource = new DataSource(buildDataSourceOptions(config));
  await dataSource.initialize();
  try {
    const outcome = await seedAdmin(dataSource, new Argon2PasswordHasher(config.argon2), process.env);
    logger.info(
      outcome === 'created'
        ? 'Initial administrator account created'
        : 'Administrator account already exists; skipped',
    );
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  createLogger({ level: 'error' }).error({ err: error }, 'Seeding failed');
  process.exitCode = 1;
});
