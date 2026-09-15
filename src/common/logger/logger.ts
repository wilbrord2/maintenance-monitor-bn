import pino, { type Logger, type LoggerOptions } from 'pino';
import { serializeError } from './error-serializer';
import { requestContextStorage } from './request-context';

export type AppLogger = Logger;

/**
 * Paths never written to logs. Values are replaced with "[REDACTED]".
 * Covers HTTP headers and any structured payload that might carry secrets.
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.passwordHash',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
  '*.temporaryPassword',
  '*.secret',
];

export interface LoggerSettings {
  readonly level: string;
  readonly pretty?: boolean;
}

export function createLogger(settings: LoggerSettings): AppLogger {
  const options: LoggerOptions = {
    level: settings.level,
    base: { service: 'maintenance-monitor-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    serializers: { err: serializeError, error: serializeError },
    formatters: {
      level: (label) => ({ level: label.toUpperCase() }),
    },
    mixin: () => {
      const requestId = requestContextStorage.getRequestId();
      return requestId ? { requestId } : {};
    },
  };

  if (settings.pretty) {
    return pino({ ...options, transport: { target: 'pino-pretty', options: { singleLine: true } } });
  }
  return pino(options);
}
