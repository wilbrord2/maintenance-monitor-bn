import { type HttpResult, ok } from '../common/http/response';
import { type AuthenticatedRequestInput } from '../common/http/route';
import { type AnalyticsFaultsQuery, type AnalyticsRangeQuery, type AnalyticsTopQuery } from './analytics.dto';
import { type AnalyticsService } from './analytics.service';

export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  async overview({ query }: AuthenticatedRequestInput<undefined, AnalyticsRangeQuery>): Promise<HttpResult> {
    return ok('Analytics overview', await this.analytics.overview(query));
  }

  async downtime({ query }: AuthenticatedRequestInput<undefined, AnalyticsTopQuery>): Promise<HttpResult> {
    return ok('Downtime analytics', await this.analytics.downtime(query));
  }

  async maintenanceEvents({
    query,
  }: AuthenticatedRequestInput<undefined, AnalyticsTopQuery>): Promise<HttpResult> {
    return ok('Maintenance event analytics', await this.analytics.maintenanceEvents(query));
  }

  async technicians({ query }: AuthenticatedRequestInput<undefined, AnalyticsTopQuery>): Promise<HttpResult> {
    return ok('Technician activity analytics', await this.analytics.technicians(query));
  }

  async faults({ query }: AuthenticatedRequestInput<undefined, AnalyticsFaultsQuery>): Promise<HttpResult> {
    return ok('Fault analytics', await this.analytics.faults(query));
  }
}
