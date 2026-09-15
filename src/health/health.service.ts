import { type DataSource } from 'typeorm';
import { withTimeout } from '../common/utils/timeout';
import { type MailTransport } from '../notifications/mail/mail.transport';

export type ComponentStatus = 'up' | 'down';
export type OverallStatus = 'ok' | 'degraded' | 'down';

export interface ComponentHealth {
  readonly status: ComponentStatus;
  readonly responseTimeMs: number;
  readonly error?: string;
}

export interface HealthReport {
  readonly status: OverallStatus;
  readonly timestamp: string;
  readonly uptimeSeconds: number;
  readonly version: string;
  readonly checks: {
    readonly application: ComponentHealth;
    readonly database: ComponentHealth;
    readonly email: ComponentHealth;
  };
}

const DATABASE_CHECK_TIMEOUT_MS = 3_000;
/** SMTP verification includes TCP, TLS and login round trips (about 1–2 s for Gmail), so it gets more room. */
const EMAIL_CHECK_TIMEOUT_MS = 8_000;
const EMAIL_CHECK_CACHE_MS = 60_000;

/**
 * Database failure makes the service "down" (503). An unreachable mail server
 * only "degrades" it: core monitoring keeps working without email.
 * Error strings are generic so health output never leaks infrastructure detail.
 */
export class HealthService {
  private emailCache: { readonly result: ComponentHealth; readonly checkedAt: number } | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly mailTransport: MailTransport,
    private readonly version: string,
    private readonly now: () => number = Date.now,
  ) {}

  async check(): Promise<HealthReport> {
    const [database, email] = await Promise.all([this.checkDatabase(), this.checkEmail()]);
    const status: OverallStatus =
      database.status === 'down' ? 'down' : email.status === 'down' ? 'degraded' : 'ok';
    return {
      status,
      timestamp: new Date(this.now()).toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      version: this.version,
      checks: { application: { status: 'up', responseTimeMs: 0 }, database, email },
    };
  }

  private async checkDatabase(): Promise<ComponentHealth> {
    return this.measure(
      async () => {
        if (!this.dataSource.isInitialized) throw new Error('not initialized');
        await this.dataSource.query('SELECT 1');
      },
      DATABASE_CHECK_TIMEOUT_MS,
      'Database unreachable',
    );
  }

  private async checkEmail(): Promise<ComponentHealth> {
    const cached = this.emailCache;
    if (cached && this.now() - cached.checkedAt < EMAIL_CHECK_CACHE_MS) return cached.result;
    const result = await this.measure(
      () => this.mailTransport.verify(),
      EMAIL_CHECK_TIMEOUT_MS,
      'Mail server unreachable',
    );
    this.emailCache = { result, checkedAt: this.now() };
    return result;
  }

  private async measure(
    probe: () => Promise<void>,
    timeoutMs: number,
    failureMessage: string,
  ): Promise<ComponentHealth> {
    const started = this.now();
    try {
      await withTimeout(probe(), timeoutMs, 'health check');
      return { status: 'up', responseTimeMs: this.now() - started };
    } catch {
      return { status: 'down', responseTimeMs: this.now() - started, error: failureMessage };
    }
  }
}
