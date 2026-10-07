import 'reflect-metadata';
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { createLogger } from '../../common/logger/logger';
import { loadConfig } from '../../config/config';
import { buildDataSourceOptions } from '../data-source.options';
import { seedInspectionSchedule } from '../seeds/inspection-schedule.seed';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const dataSource = new DataSource(buildDataSourceOptions(config));
  await dataSource.initialize();
  try {
    const result = await seedInspectionSchedule(dataSource);
    logger.info(result, 'Inspection schedule seeded (existing rows left unchanged)');
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  createLogger({ level: 'error' }).error({ err: error }, 'Inspection schedule seeding failed');
  process.exitCode = 1;
});
