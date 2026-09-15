import { envSchema, type Env } from './env.schema';

export type NodeEnv = Env['NODE_ENV'];
export type LogLevel = Env['LOG_LEVEL'];

export interface AppConfig {
  readonly env: NodeEnv;
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly trustProxy: boolean | number | string;
  readonly corsOrigins: readonly string[];
  readonly bodySizeLimit: string;
  readonly database: {
    readonly url: string;
    readonly ssl: false | { readonly rejectUnauthorized: boolean };
    readonly poolMax: number;
    readonly logging: boolean;
  };
  readonly jwt: {
    readonly accessSecret: string;
    readonly refreshSecret: string;
    readonly accessTtlSeconds: number;
    readonly refreshTtlSeconds: number;
    readonly issuer: string;
    readonly audience: string;
  };
  readonly auth: {
    readonly maxLoginAttempts: number;
    readonly lockoutMinutes: number;
    readonly temporaryPasswordTtlHours: number;
    readonly passwordResetTtlMinutes: number;
    readonly passwordResetUrl: string;
    readonly loginUrl: string;
    readonly refreshCookieName: string;
    readonly cookieSecure: boolean;
  };
  readonly argon2: {
    readonly memoryCost: number;
    readonly timeCost: number;
    readonly parallelism: number;
  };
  readonly mail: {
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly username: string | undefined;
    readonly password: string | undefined;
    readonly from: string;
    readonly fromName: string;
  };
  readonly rateLimit: {
    readonly windowMs: number;
    readonly max: number;
    readonly authWindowMs: number;
    readonly authMax: number;
    readonly forgotPasswordMax: number;
  };
  readonly swagger: {
    readonly enabled: boolean;
    readonly username: string | undefined;
    readonly password: string | undefined;
  };
}

export class ConfigValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigValidationError';
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function parseTrustProxy(raw: string): boolean | number | string {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false' || value === '') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

/**
 * Uses DATABASE_URL when set; otherwise assembles a connection string from the
 * individual DATABASE_* values, percent-encoding credentials and database name.
 */
function databaseUrl(env: Env): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const host = env.DATABASE_HOST ?? 'localhost';
  const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const user = encodeURIComponent(env.DATABASE_USERNAME ?? '');
  const password = env.DATABASE_PASSWORD ? `:${encodeURIComponent(env.DATABASE_PASSWORD)}` : '';
  const name = encodeURIComponent(env.DATABASE_NAME ?? '');
  return `postgres://${user}${password}@${hostPart}:${env.DATABASE_PORT}/${name}`;
}

/**
 * Builds the typed application configuration from environment variables.
 * Error messages name the offending variables but never echo their values.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';

  return {
    env: env.NODE_ENV,
    isProduction,
    isTest: env.NODE_ENV === 'test',
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    corsOrigins: env.CORS_ORIGIN.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    bodySizeLimit: env.BODY_SIZE_LIMIT,
    database: {
      url: databaseUrl(env),
      ssl: env.DATABASE_SSL ? { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED } : false,
      poolMax: env.DATABASE_POOL_MAX,
      logging: env.DATABASE_LOGGING,
    },
    jwt: {
      accessSecret: env.JWT_ACCESS_SECRET,
      refreshSecret: env.JWT_REFRESH_SECRET,
      accessTtlSeconds: env.JWT_ACCESS_EXPIRES_IN,
      refreshTtlSeconds: env.JWT_REFRESH_EXPIRES_IN,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    },
    auth: {
      maxLoginAttempts: env.LOGIN_MAX_ATTEMPTS,
      lockoutMinutes: env.LOGIN_LOCK_MINUTES,
      temporaryPasswordTtlHours: env.TEMP_PASSWORD_TTL_HOURS,
      passwordResetTtlMinutes: env.PASSWORD_RESET_TTL_MINUTES,
      passwordResetUrl: env.PASSWORD_RESET_URL,
      loginUrl: env.APP_LOGIN_URL,
      refreshCookieName: env.REFRESH_COOKIE_NAME,
      cookieSecure: env.COOKIE_SECURE ?? isProduction,
    },
    argon2: {
      memoryCost: env.ARGON2_MEMORY_COST,
      timeCost: env.ARGON2_TIME_COST,
      parallelism: env.ARGON2_PARALLELISM,
    },
    mail: {
      host: env.MAIL_HOST,
      port: env.MAIL_PORT,
      secure: env.MAIL_SECURE,
      username: nonEmpty(env.MAIL_USERNAME),
      password: nonEmpty(env.MAIL_PASSWORD),
      from: env.MAIL_FROM,
      fromName: env.MAIL_FROM_NAME,
    },
    rateLimit: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      authWindowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
      authMax: env.AUTH_RATE_LIMIT_MAX,
      forgotPasswordMax: env.FORGOT_PASSWORD_RATE_LIMIT_MAX,
    },
    swagger: {
      enabled: env.SWAGGER_ENABLED ?? !isProduction,
      username: nonEmpty(env.SWAGGER_USERNAME),
      password: nonEmpty(env.SWAGGER_PASSWORD),
    },
  };
}
