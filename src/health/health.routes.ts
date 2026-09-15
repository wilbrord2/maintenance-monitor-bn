import { z } from 'zod';
import { publicRoute, type RouteDefinition } from '../common/http/route';
import { type HealthController } from './health.controller';

const componentSchema = z.object({
  status: z.enum(['up', 'down']),
  responseTimeMs: z.number(),
  error: z.string().optional(),
});

const healthReportSchema = z
  .object({
    status: z.enum(['ok', 'degraded', 'down']),
    timestamp: z.iso.datetime(),
    uptimeSeconds: z.number(),
    version: z.string(),
    checks: z.object({ application: componentSchema, database: componentSchema, email: componentSchema }),
  })
  .meta({ id: 'HealthReport' });

export function healthRoutes(controller: HealthController): RouteDefinition[] {
  return [
    publicRoute({
      method: 'get',
      path: '/health',
      tags: ['Health'],
      summary: 'Service health (application, database, email)',
      description:
        'Returns 200 when healthy or degraded (email unavailable) and 503 when the database is down.',
      response: { status: 200, description: 'Health report', data: healthReportSchema },
      errors: [503],
      handler: () => controller.check(),
    }),
    publicRoute({
      method: 'get',
      path: '/health/live',
      tags: ['Health'],
      summary: 'Liveness probe (no dependency checks)',
      response: { status: 200, description: 'Process is alive', data: z.object({ status: z.literal('ok') }) },
      handler: () => controller.live(),
    }),
  ];
}
