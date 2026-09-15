/**
 * DataSource used by the TypeORM CLI (migration:generate). The application
 * builds its own DataSource in the composition root.
 */
import 'reflect-metadata';
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { loadConfig } from '../config/config';
import { buildDataSourceOptions } from './data-source.options';

export default new DataSource(buildDataSourceOptions(loadConfig()));
