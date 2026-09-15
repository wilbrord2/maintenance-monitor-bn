import { ok, type HttpResult } from '../common/http/response';
import { type HealthService } from './health.service';

export class HealthController {
  constructor(private readonly health: HealthService) {}

  async check(): Promise<HttpResult> {
    const report = await this.health.check();
    if (report.status === 'down') {
      return { status: 503, message: 'Service unavailable', data: report };
    }
    return ok(report.status === 'ok' ? 'Service healthy' : 'Service degraded', report);
  }

  live(): Promise<HttpResult> {
    return Promise.resolve(ok('Alive', { status: 'ok' }));
  }
}
