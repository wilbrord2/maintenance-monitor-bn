import cors from 'cors';
import { type RequestHandler } from 'express';
import helmet from 'helmet';
import { type AppConfig } from '../../config/config';
import { AppError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-codes';
import { REQUEST_ID_HEADER } from './request-id.middleware';

export function helmetMiddleware(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        // Swagger UI needs inline styles; scripts remain restricted to self.
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
  });
}

export function corsMiddleware(config: AppConfig): RequestHandler {
  const allowed = new Set(config.corsOrigins);
  const allowAll = !config.isProduction && allowed.has('*');
  return cors({
    origin: (origin, callback) => {
      // Non-browser clients send no Origin header.
      if (!origin || allowAll || allowed.has(origin)) {
        callback(null, true);
        return;
      }
      callback(AppError.forbidden('Origin not allowed', ErrorCode.CORS_ORIGIN_DENIED));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', REQUEST_ID_HEADER],
    exposedHeaders: [REQUEST_ID_HEADER, 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
    maxAge: 600,
  });
}

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Rejects request bodies that are not JSON, rather than silently ignoring them. */
export const requireJsonBodyMiddleware: RequestHandler = (req, _res, next) => {
  const hasBody = Number(req.get('content-length') ?? 0) > 0 || req.get('transfer-encoding') !== undefined;
  if (METHODS_WITH_BODY.has(req.method) && hasBody && !req.is('application/json')) {
    next(new AppError(415, ErrorCode.UNSUPPORTED_MEDIA_TYPE, 'Request body must be application/json'));
    return;
  }
  next();
};

/** Prevents caching of API responses that may contain personal or operational data. */
export const noStoreMiddleware: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};
