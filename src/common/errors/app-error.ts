import { ErrorCode } from './error-codes';

export interface ErrorDetail {
  readonly field: string;
  readonly message: string;
}

/**
 * An expected, client-facing error. Its message and code are safe to return
 * to API consumers; anything else thrown is treated as an internal error.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: readonly ErrorDetail[],
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, code: ErrorCode = ErrorCode.BAD_REQUEST): AppError {
    return new AppError(400, code, message);
  }

  static validation(details: readonly ErrorDetail[], message = 'Request validation failed'): AppError {
    return new AppError(400, ErrorCode.VALIDATION_ERROR, message, details);
  }

  static unauthorized(
    message = 'Authentication required',
    code: ErrorCode = ErrorCode.UNAUTHORIZED,
  ): AppError {
    return new AppError(401, code, message);
  }

  static forbidden(
    message = 'You do not have permission to perform this action',
    code: ErrorCode = ErrorCode.FORBIDDEN,
  ): AppError {
    return new AppError(403, code, message);
  }

  static notFound(message: string, code: ErrorCode = ErrorCode.NOT_FOUND): AppError {
    return new AppError(404, code, message);
  }

  static conflict(message: string, code: ErrorCode = ErrorCode.CONFLICT): AppError {
    return new AppError(409, code, message);
  }

  /** The request is well-formed but violates a business rule. */
  static unprocessable(message: string, code: ErrorCode, details?: readonly ErrorDetail[]): AppError {
    return new AppError(422, code, message, details);
  }

  static tooManyRequests(message: string, code: ErrorCode = ErrorCode.RATE_LIMITED): AppError {
    return new AppError(429, code, message);
  }
}
