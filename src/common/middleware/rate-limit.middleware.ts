import { type Request, type RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { type AppConfig } from '../../config/config';
import { AppError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-codes';

function limiter(options: {
  windowMs: number;
  limit: number;
  message: string;
  keyGenerator?: (req: Request) => string;
}): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(options.keyGenerator ? { keyGenerator: options.keyGenerator } : {}),
    handler: (_req, _res, next) => {
      next(AppError.tooManyRequests(options.message, ErrorCode.RATE_LIMITED));
    },
  });
}

function clientIp(req: Request): string {
  return ipKeyGenerator(req.ip ?? 'unknown');
}

/** Normalised account identifier from the body, used to throttle per account as well as per IP. */
function emailFromBody(req: Request): string {
  const body: unknown = req.body;
  if (typeof body === 'object' && body !== null && 'email' in body && typeof body.email === 'string') {
    return body.email.trim().toLowerCase().slice(0, 254);
  }
  return '';
}

export interface RateLimiters {
  readonly global: RequestHandler;
  /** Per IP + account: slows guessing against one account. */
  readonly login: RequestHandler;
  /** Per IP across all auth endpoints: slows password spraying across many accounts. */
  readonly authPerIp: RequestHandler;
  readonly passwordRecovery: RequestHandler;
  readonly sensitive: RequestHandler;
}

/** Multiplier applied to AUTH_RATE_LIMIT_MAX for the IP-wide authentication limiter. */
const AUTH_PER_IP_MULTIPLIER = 5;

/**
 * In-memory limiters (per process). For multiple API replicas, back these with
 * a shared store (e.g. rate-limit-redis); account lockout is already DB-backed.
 */
export function createRateLimiters(config: AppConfig): RateLimiters {
  const { rateLimit: settings } = config;
  return {
    global: limiter({
      windowMs: settings.windowMs,
      limit: settings.max,
      message: 'Too many requests, please try again later',
    }),
    login: limiter({
      windowMs: settings.authWindowMs,
      limit: settings.authMax,
      message: 'Too many login attempts, please try again later',
      keyGenerator: (req) => `${clientIp(req)}:${emailFromBody(req)}`,
    }),
    authPerIp: limiter({
      windowMs: settings.authWindowMs,
      limit: settings.authMax * AUTH_PER_IP_MULTIPLIER,
      message: 'Too many authentication requests from this address, please try again later',
      keyGenerator: clientIp,
    }),
    passwordRecovery: limiter({
      windowMs: settings.authWindowMs,
      limit: settings.forgotPasswordMax,
      message: 'Too many password recovery requests, please try again later',
    }),
    sensitive: limiter({
      windowMs: settings.authWindowMs,
      limit: settings.authMax,
      message: 'Too many requests, please try again later',
    }),
  };
}
