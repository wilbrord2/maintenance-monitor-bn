import { type Request } from 'express';
import { pinoHttp, type Options } from 'pino-http';
import { type AppLogger } from '../logger/logger';

export function httpLoggerMiddleware(logger: AppLogger) {
  const options: Options = {
    logger,
    genReqId: (req) => (req as Request).requestId,
    customLogLevel: (_req, res, error) => {
      if (error || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: (req, res) => `${req.method ?? ''} ${req.url ?? ''} ${res.statusCode}`,
    customErrorMessage: (req, res) => `${req.method ?? ''} ${req.url ?? ''} ${res.statusCode}`,
    // Log only non-sensitive request fields; bodies and query strings are never logged.
    serializers: {
      req: (req: { id: string; method: string; url: string; remoteAddress?: string }) => ({
        id: req.id,
        method: req.method,
        path: req.url.split('?')[0],
        remoteAddress: req.remoteAddress,
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
    autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/api/v1/health/live') },
  };
  return pinoHttp(options);
}
