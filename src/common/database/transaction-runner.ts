import { type DataSource, type EntityManager } from 'typeorm';

export type TransactionWork<T> = (manager: EntityManager) => Promise<T>;

/** Runs a unit of work in a READ COMMITTED transaction; any thrown error rolls it back. */
export class TransactionRunner {
  constructor(private readonly dataSource: DataSource) {}

  run<T>(work: TransactionWork<T>): Promise<T> {
    return this.dataSource.transaction('READ COMMITTED', work);
  }
}
