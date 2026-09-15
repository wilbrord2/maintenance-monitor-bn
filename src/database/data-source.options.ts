import { type DataSourceOptions } from 'typeorm';
import { type AppConfig } from '../config/config';
import { ENTITIES } from './entities';
import { MIGRATIONS } from './migrations';

export function buildDataSourceOptions(config: Pick<AppConfig, 'database'>): DataSourceOptions {
  return {
    type: 'postgres',
    url: config.database.url,
    ssl: config.database.ssl,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    migrationsTableName: 'schema_migrations',
    migrationsTransactionMode: 'each',
    // The schema is managed exclusively through migrations.
    synchronize: false,
    migrationsRun: false,
    logging: config.database.logging ? ['query', 'error', 'warn'] : ['error'],
    extra: {
      max: config.database.poolMax,
      application_name: 'maintenance-monitor-api',
    },
  };
}
