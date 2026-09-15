import { ConfigValidationError, loadConfig } from './config';

const validEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'development',
  CORS_ORIGIN: 'http://localhost:5173, https://app.example.com',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/mm',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  PASSWORD_RESET_URL: 'http://localhost:5173/reset-password',
  APP_LOGIN_URL: 'http://localhost:5173/login',
  MAIL_HOST: 'smtp.example.com',
  MAIL_PORT: '587',
  MAIL_FROM: 'noreply@example.com',
});

describe('loadConfig', () => {
  it('builds a typed configuration with defaults', () => {
    const config = loadConfig(validEnv());
    expect(config.port).toBe(3000);
    expect(config.corsOrigins).toEqual(['http://localhost:5173', 'https://app.example.com']);
    expect(config.jwt.accessTtlSeconds).toBe(900);
    expect(config.jwt.refreshTtlSeconds).toBe(604800);
    expect(config.auth.cookieSecure).toBe(false);
    expect(config.swagger.enabled).toBe(true);
    expect(config.database.ssl).toBe(false);
  });

  it('parses durations and booleans', () => {
    const config = loadConfig({
      ...validEnv(),
      JWT_ACCESS_EXPIRES_IN: '10m',
      JWT_REFRESH_EXPIRES_IN: '30d',
      DATABASE_SSL: 'true',
      TRUST_PROXY: '1',
    });
    expect(config.jwt.accessTtlSeconds).toBe(600);
    expect(config.jwt.refreshTtlSeconds).toBe(2_592_000);
    expect(config.database.ssl).toEqual({ rejectUnauthorized: true });
    expect(config.trustProxy).toBe(1);
  });

  it('rejects missing and weak secrets without echoing their values', () => {
    const env: NodeJS.ProcessEnv = { ...validEnv(), JWT_ACCESS_SECRET: 'short-secret-value' };
    delete env.DATABASE_URL;
    try {
      loadConfig(env);
      throw new Error('expected loadConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const message = (error as Error).message;
      expect(message).toContain('JWT_ACCESS_SECRET');
      expect(message).toContain('DATABASE_URL');
      expect(message).not.toContain('short-secret-value');
    }
  });

  describe('database connection settings', () => {
    const withoutUrl = (): NodeJS.ProcessEnv => {
      const env = validEnv();
      delete env.DATABASE_URL;
      return env;
    };

    it('builds the connection string from individual DATABASE_* values', () => {
      const config = loadConfig({
        ...withoutUrl(),
        DATABASE_HOST: 'localhost',
        DATABASE_PORT: '5433',
        DATABASE_USERNAME: 'postgres',
        DATABASE_PASSWORD: '123',
        DATABASE_NAME: 'maintenance_monitor',
      });
      expect(config.database.url).toBe('postgres://postgres:123@localhost:5433/maintenance_monitor');
    });

    it('percent-encodes credentials and defaults the port to 5432', () => {
      const config = loadConfig({
        ...withoutUrl(),
        DATABASE_URL: '',
        DATABASE_HOST: 'db.internal',
        DATABASE_USERNAME: 'app@ops',
        DATABASE_PASSWORD: 'p@ss:w/rd#1',
        DATABASE_NAME: 'mm',
      });
      expect(config.database.url).toBe('postgres://app%40ops:p%40ss%3Aw%2Frd%231@db.internal:5432/mm');
    });

    it('prefers DATABASE_URL when both forms are present', () => {
      const config = loadConfig({
        ...validEnv(),
        DATABASE_HOST: 'ignored',
        DATABASE_USERNAME: 'x',
        DATABASE_NAME: 'y',
      });
      expect(config.database.url).toBe('postgres://user:pass@localhost:5432/mm');
    });

    it('names each missing value when neither form is complete', () => {
      expect(() => loadConfig({ ...withoutUrl(), DATABASE_HOST: 'localhost' })).toThrow(
        /DATABASE_USERNAME: is required when DATABASE_URL is not set[\s\S]*DATABASE_NAME/,
      );
    });
  });

  it('requires distinct access and refresh secrets', () => {
    expect(() => loadConfig({ ...validEnv(), JWT_REFRESH_SECRET: 'a'.repeat(40) })).toThrow(
      /JWT_REFRESH_SECRET/,
    );
  });

  it('requires the access token to be shorter-lived than the refresh token', () => {
    expect(() => loadConfig({ ...validEnv(), JWT_ACCESS_EXPIRES_IN: '8d' })).toThrow(/JWT_ACCESS_EXPIRES_IN/);
  });

  it('applies production hardening rules', () => {
    const production = { ...validEnv(), NODE_ENV: 'production' };
    expect(() => loadConfig({ ...production, CORS_ORIGIN: '*' })).toThrow(/CORS_ORIGIN/);
    expect(() => loadConfig({ ...production, SWAGGER_ENABLED: 'true' })).toThrow(/SWAGGER_PASSWORD/);

    const config = loadConfig(production);
    expect(config.swagger.enabled).toBe(false);
    expect(config.auth.cookieSecure).toBe(true);
  });
});
