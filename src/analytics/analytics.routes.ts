import { ROLES } from '../common/enums/role.enum';
import { protectedRoute, type RouteDefinition } from '../common/http/route';
import { type AnalyticsController } from './analytics.controller';
import {
  analyticsFaultsQuerySchema,
  analyticsRangeQuerySchema,
  analyticsTopQuerySchema,
  downtimeResponseSchema,
  faultsResponseSchema,
  maintenanceEventsResponseSchema,
  overviewResponseSchema,
  techniciansResponseSchema,
} from './analytics.dto';

const TAGS = ['Analytics'];
const RANGE_NOTE =
  'Log metrics cover logs whose `startedAt` falls in the range: the last 30 days by default, `?days=N`, ' +
  'or `?from=YYYY-MM-DD&to=YYYY-MM-DD` (UTC, inclusive, max 366 days). Invalid ranges return 400 INVALID_TIME_RANGE.';

export function analyticsRoutes(controller: AnalyticsController): RouteDefinition[] {
  return [
    protectedRoute({
      method: 'get',
      path: '/analytics/overview',
      tags: TAGS,
      summary: 'Fleet status and log totals',
      description: `Machine counts reflect current status (deactivated machines are counted separately). ${RANGE_NOTE}`,
      roles: ROLES,
      query: analyticsRangeQuerySchema,
      response: { status: 200, description: 'Overview', data: overviewResponseSchema },
      handler: (ctx) => controller.overview(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/analytics/downtime',
      tags: TAGS,
      summary: 'Total downtime and downtime by machine',
      description: RANGE_NOTE,
      roles: ROLES,
      query: analyticsTopQuerySchema,
      response: { status: 200, description: 'Downtime analytics', data: downtimeResponseSchema },
      handler: (ctx) => controller.downtime(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/analytics/maintenance-events',
      tags: TAGS,
      summary: 'Maintenance events by machine (open vs closed)',
      description: RANGE_NOTE,
      roles: ROLES,
      query: analyticsTopQuerySchema,
      response: {
        status: 200,
        description: 'Maintenance event analytics',
        data: maintenanceEventsResponseSchema,
      },
      handler: (ctx) => controller.maintenanceEvents(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/analytics/technicians',
      tags: TAGS,
      summary: 'Logs by technician',
      description: RANGE_NOTE,
      roles: ROLES,
      query: analyticsTopQuerySchema,
      response: { status: 200, description: 'Technician activity', data: techniciansResponseSchema },
      handler: (ctx) => controller.technicians(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/analytics/faults',
      tags: TAGS,
      summary: 'Common fault descriptions and recurring machine issues',
      description: `Fault text is normalised (case and whitespace) before grouping. ${RANGE_NOTE}`,
      roles: ROLES,
      query: analyticsFaultsQuerySchema,
      response: { status: 200, description: 'Fault analytics', data: faultsResponseSchema },
      handler: (ctx) => controller.faults(ctx),
    }),
  ];
}
