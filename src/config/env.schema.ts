import { z } from 'zod';
import { parseDurationToSeconds } from '../common/utils/duration';

const duration = z
  .string()
  .refine((value) => parseDurationToSeconds(value) !== null, 'must be a duration such as 15m, 12h or 7d')
  .transform((value) => parseDurationToSeconds(value) ?? 0);

const booleanFlag = z.stringbool().default(false);

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

/** Treats `KEY=` (empty) the same as an unset variable. */
const optionalString = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const DATABASE_PARTS = ['DATABASE_HOST', 'DATABASE_USERNAME', 'DATABASE_NAME'] as const;

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TRUST_PROXY: z.string().default('false'),
    CORS_ORIGIN: z.string().min(1, 'is required'),
    BODY_SIZE_LIMIT: z.string().default('100kb'),

    // Either DATABASE_URL, or the individual DATABASE_HOST/PORT/USERNAME/PASSWORD/NAME values.
    DATABASE_URL: optionalString(z.url({ protocol: /^postgres(ql)?$/ })),
    DATABASE_HOST: optionalString(z.string()),
    DATABASE_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
    DATABASE_USERNAME: optionalString(z.string()),
    DATABASE_PASSWORD: z.string().default(''),
    DATABASE_NAME: optionalString(z.string()),
    DATABASE_SSL: booleanFlag,
    DATABASE_SSL_REJECT_UNAUTHORIZED: z.stringbool().default(true),
    DATABASE_POOL_MAX: positiveInt(10),
    DATABASE_LOGGING: booleanFlag,

    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_ACCESS_EXPIRES_IN: duration.default(900),
    JWT_REFRESH_EXPIRES_IN: duration.default(604800),
    JWT_ISSUER: z.string().min(1).default('maintenance-monitor'),
    JWT_AUDIENCE: z.string().min(1).default('maintenance-monitor-clients'),

    REFRESH_COOKIE_NAME: z.string().min(1).default('mm_refresh_token'),
    COOKIE_SECURE: z.stringbool().optional(),

    ARGON2_MEMORY_COST: z.coerce.number().int().min(1024).default(19456),
    ARGON2_TIME_COST: z.coerce.number().int().min(1).default(2),
    ARGON2_PARALLELISM: z.coerce.number().int().min(1).default(1),

    LOGIN_MAX_ATTEMPTS: positiveInt(5),
    LOGIN_LOCK_MINUTES: positiveInt(15),
    TEMP_PASSWORD_TTL_HOURS: positiveInt(72),
    PASSWORD_RESET_TTL_MINUTES: positiveInt(30),
    PASSWORD_RESET_URL: z.url(),
    APP_LOGIN_URL: z.url(),

    MAIL_HOST: z.string().min(1),
    MAIL_PORT: z.coerce.number().int().min(1).max(65535),
    MAIL_SECURE: booleanFlag,
    MAIL_USERNAME: z.string().optional(),
    MAIL_PASSWORD: z.string().optional(),
    MAIL_FROM: z.email(),
    MAIL_FROM_NAME: z.string().min(1).default('Maintenance Monitor'),

    RATE_LIMIT_WINDOW_MS: positiveInt(60_000),
    RATE_LIMIT_MAX: positiveInt(300),
    AUTH_RATE_LIMIT_WINDOW_MS: positiveInt(900_000),
    AUTH_RATE_LIMIT_MAX: positiveInt(20),
    FORGOT_PASSWORD_RATE_LIMIT_MAX: positiveInt(5),

    SWAGGER_ENABLED: z.stringbool().optional(),
    SWAGGER_USERNAME: z.string().optional(),
    SWAGGER_PASSWORD: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (!env.DATABASE_URL) {
      for (const key of DATABASE_PARTS) {
        if (!env[key]) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'is required when DATABASE_URL is not set' });
        }
      }
    }
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message: 'must differ from JWT_ACCESS_SECRET',
      });
    }
    if (env.JWT_ACCESS_EXPIRES_IN >= env.JWT_REFRESH_EXPIRES_IN) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_ACCESS_EXPIRES_IN'],
        message: 'must be shorter than JWT_REFRESH_EXPIRES_IN',
      });
    }
    if (Boolean(env.MAIL_USERNAME) !== Boolean(env.MAIL_PASSWORD)) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_PASSWORD'],
        message: 'MAIL_USERNAME and MAIL_PASSWORD must be provided together',
      });
    }
    if (env.NODE_ENV === 'production') {
      if (env.CORS_ORIGIN.split(',').some((origin) => origin.trim() === '*')) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ORIGIN'],
          message: 'wildcard origin is not allowed in production',
        });
      }
      if (env.SWAGGER_ENABLED === true && (!env.SWAGGER_USERNAME || !env.SWAGGER_PASSWORD)) {
        ctx.addIssue({
          code: 'custom',
          path: ['SWAGGER_PASSWORD'],
          message: 'SWAGGER_USERNAME and SWAGGER_PASSWORD are required when Swagger is enabled in production',
        });
      }
      if (
        env.SWAGGER_PASSWORD !== undefined &&
        env.SWAGGER_PASSWORD.length > 0 &&
        env.SWAGGER_PASSWORD.length < 12
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['SWAGGER_PASSWORD'],
          message: 'must be at least 12 characters',
        });
      }
    }
  });

export type Env = z.output<typeof envSchema>;
