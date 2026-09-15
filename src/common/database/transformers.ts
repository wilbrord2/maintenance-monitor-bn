import { type ValueTransformer } from 'typeorm';

/** PostgreSQL returns NUMERIC/BIGINT as strings; expose them as JS numbers. */
export const numericTransformer: ValueTransformer = {
  to: (value: number | null | undefined): number | null | undefined => value,
  from: (value: string | null): number | null => (value === null ? null : Number(value)),
};
