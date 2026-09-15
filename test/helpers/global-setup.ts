import 'reflect-metadata';
import './load-test-env';
import { DataSource } from 'typeorm';
import { loadConfig } from '../../src/config/config';
import { buildDataSourceOptions } from '../../src/database/data-source.options';

/** Applies all migrations to the test database once before the integration suite. */
export default async function globalSetup(): Promise<void> {
  const config = loadConfig();
  if (!config.isTest) throw new Error('Integration tests must run with NODE_ENV=test');
  if (!/test/i.test(new URL(config.database.url).pathname)) {
    throw new Error(
      'Refusing to run integration tests against a database whose name does not contain "test"',
    );
  }
  const dataSource = new DataSource(buildDataSourceOptions(config));
  await dataSource.initialize();
  try {
    await dataSource.runMigrations({ transaction: 'each' });
  } finally {
    await dataSource.destroy();
  }
}
