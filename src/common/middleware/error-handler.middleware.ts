import { type NextFunction, type Request, type Response } from 'express';
import { AppError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-codes';
import { type ErrorResponseBody } from '../http/response';
import { type AppLogger } from '../logger/logger';

interface HttpLikeError {
  readonly status?: number;
  readonly statusCode?: number;
  readonly type?: string;
  readonly expose?: boolean;
}

function asHttpLikeError(error: unknown): HttpLikeError | null {
  return typeof error === 'object' && error !== null ? error : null;
}

/** Maps errors raised by Express/body-parser into safe AppErrors. */
function normalizeFrameworkError(error: unknown): AppError | null {
  const httpError = asHttpLikeError(error);
  if (!httpError) return null;
  const status = httpError.statusCode ?? httpError.status;
  if (httpError.type === 'entity.too.large') {
    return new AppError(413, ErrorCode.PAYLOAD_TOO_LARGE, 'Request body is too large');
  }
  if (httpError.type === 'entity.parse.failed') {
    return AppError.badRequest('Malformed JSON request body');
  }
  if (typeof status === 'number' && status >= 400 && status < 500 && httpError.expose === true) {
    return new AppError(status, ErrorCode.BAD_REQUEST, 'Invalid request');
  }
  return null;
}

const INTERNAL_ERROR_MESSAGE = 'An unexpected error occurred';

/**
 * Centralised error responses. Only AppErrors (and recognised framework errors)
 * reach clients with their message; everything else becomes a generic 500 in
 * every environment — details (never SQL parameters) go to the log only,
 * correlated by requestId.
 */
export function errorHandlerMiddleware(logger: AppLogger) {
  return (error: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const appError = error instanceof AppError ? error : normalizeFrameworkError(error);

    if (appError) {
      if (appError.statusCode >= 500) logger.error({ err: appError }, appError.message);
    } else {
      logger.error({ err: error, path: req.path, method: req.method }, 'Unhandled error');
    }

    const status = appError?.statusCode ?? 500;

    const body: ErrorResponseBody = {
      success: false,
      message: appError?.message ?? INTERNAL_ERROR_MESSAGE,
      code: appError?.code ?? ErrorCode.INTERNAL_ERROR,
      timestamp: new Date().toISOString(),
      path: req.originalUrl.split('?')[0] ?? req.path,
      requestId: req.requestId,
      ...(appError?.details && appError.details.length > 0 ? { details: appError.details } : {}),
    };

    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(status).json(body);
  };
}

export function notFoundMiddleware(req: Request, _res: Response, next: NextFunction): void {
  next(AppError.notFound(`Route ${req.method} ${req.path} not found`, ErrorCode.ROUTE_NOT_FOUND));
}
