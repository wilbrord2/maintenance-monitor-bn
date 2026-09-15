const MAX_STACK_LINES = 15;

export interface SerializedError {
  readonly type: string;
  readonly message: string;
  readonly code?: string;
  readonly constraint?: string;
  readonly statusCode?: number;
  readonly stack?: string;
  readonly cause?: SerializedError;
}

function readString(source: object, key: string): string | undefined {
  const value: unknown = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Serialises errors for logs without their enumerable payloads. In particular
 * TypeORM's QueryFailedError carries `query` and `parameters` (which may hold
 * password hashes, tokens or personal data); only safe identifying fields are kept.
 */
export function serializeError(error: unknown, depth = 0): SerializedError {
  if (!(error instanceof Error)) {
    return { type: typeof error, message: typeof error === 'string' ? error : 'Non-error value thrown' };
  }

  const driverError: unknown = (error as { driverError?: unknown }).driverError;
  const driver = typeof driverError === 'object' && driverError !== null ? driverError : undefined;
  const code = readString(error, 'code') ?? (driver ? readString(driver, 'code') : undefined);
  const constraint = driver ? readString(driver, 'constraint') : undefined;
  const statusCode: unknown = (error as { statusCode?: unknown }).statusCode;

  const cause: unknown = (error as { cause?: unknown }).cause;
  return {
    type: error.name,
    message: error.message,
    ...(code ? { code } : {}),
    ...(constraint ? { constraint } : {}),
    ...(typeof statusCode === 'number' ? { statusCode } : {}),
    ...(error.stack ? { stack: error.stack.split('\n').slice(0, MAX_STACK_LINES).join('\n') } : {}),
    ...(cause !== undefined && depth < 2 ? { cause: serializeError(cause, depth + 1) } : {}),
  };
}
