import { type DataSource } from 'typeorm';
import { type MailTransport } from '../notifications/mail/mail.transport';
import { HealthService } from './health.service';

function setup(options: { dbUp?: boolean; initialized?: boolean; mailUp?: boolean } = {}) {
  const dataSource = {
    isInitialized: options.initialized ?? true,
    query: jest.fn(() =>
      options.dbUp === false ? Promise.reject(new Error('ECONNREFUSED 10.0.0.5:5432')) : Promise.resolve([]),
    ),
  } as unknown as DataSource;
  const mail = {
    verify: jest.fn(() =>
      options.mailUp === false ? Promise.reject(new Error('auth failed for smtp-user')) : Promise.resolve(),
    ),
  } as unknown as jest.Mocked<MailTransport>;
  let now = 1_000_000;
  const service = new HealthService(dataSource, mail, '1.2.3', () => now);
  return { service, mail, advance: (ms: number) => (now += ms) };
}

describe('HealthService', () => {
  it('is ok when every dependency is up', async () => {
    const report = await setup().service.check();
    expect(report).toMatchObject({
      status: 'ok',
      version: '1.2.3',
      checks: { database: { status: 'up' }, email: { status: 'up' } },
    });
  });

  it('is down when the database is unreachable, without leaking connection details', async () => {
    const report = await setup({ dbUp: false }).service.check();
    expect(report.status).toBe('down');
    expect(report.checks.database).toMatchObject({ status: 'down', error: 'Database unreachable' });
    expect(JSON.stringify(report)).not.toContain('10.0.0.5');
  });

  it('is down when the data source is not initialised', async () => {
    expect((await setup({ initialized: false }).service.check()).status).toBe('down');
  });

  it('is degraded when only email is unavailable, and caches the email probe', async () => {
    const { service, mail, advance } = setup({ mailUp: false });
    const report = await service.check();
    expect(report.status).toBe('degraded');
    expect(JSON.stringify(report)).not.toContain('smtp-user');

    await service.check();
    expect(mail.verify).toHaveBeenCalledTimes(1);
    advance(61_000);
    await service.check();
    expect(mail.verify).toHaveBeenCalledTimes(2);
  });
});
