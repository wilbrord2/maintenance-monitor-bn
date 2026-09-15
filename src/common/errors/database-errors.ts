import { QueryFailedError } from 'typeorm';

/** PostgreSQL SQLSTATE codes the application reacts to. */
export const PgErrorCode = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  LOCK_NOT_AVAILABLE: '55P03',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
} as const;

interface PgDriverError {
  readonly code?: string;
  readonly constraint?: string;
}

function driverError(error: unknown): PgDriverError | null {
  if (!(error instanceof QueryFailedError)) return null;
  const driver: unknown = error.driverError;
  if (typeof driver !== 'object' || driver === null) return null;
  const { code, constraint } = driver as Record<string, unknown>;
  return {
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof constraint === 'string' ? { constraint } : {}),
  };
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = driverError(error);
  return (
    pg?.code === PgErrorCode.UNIQUE_VIOLATION && (constraint === undefined || pg.constraint === constraint)
  );
}

export function isForeignKeyViolation(error: unknown): boolean {
  return driverError(error)?.code === PgErrorCode.FOREIGN_KEY_VIOLATION;
}

export function isCheckViolation(error: unknown): boolean {
  return driverError(error)?.code === PgErrorCode.CHECK_VIOLATION;
}

export function isConcurrencyFailure(error: unknown): boolean {
  const code = driverError(error)?.code;
  return (
    code === PgErrorCode.LOCK_NOT_AVAILABLE ||
    code === PgErrorCode.SERIALIZATION_FAILURE ||
    code === PgErrorCode.DEADLOCK_DETECTED
  );
}

export function constraintName(error: unknown): string | undefined {
  return driverError(error)?.constraint;
}
