import { Role } from '../common/enums/role.enum';
import { protectedRoute, type RouteDefinition } from '../common/http/route';
import { type AuditController } from './audit.controller';
import { auditIdParams, auditLogResponseSchema, listAuditLogsQuerySchema } from './audit.dto';

const TAGS = ['Audit logs'];
const ADMIN = [Role.ADMIN] as const;

export function auditRoutes(controller: AuditController): RouteDefinition[] {
  return [
    protectedRoute({
      method: 'get',
      path: '/audit-logs',
      tags: TAGS,
      summary: 'List audit log entries',
      description: 'Newest first by default. Credentials and tokens are never stored in audit values.',
      roles: ADMIN,
      query: listAuditLogsQuerySchema,
      response: {
        status: 200,
        description: 'Paginated audit entries',
        data: auditLogResponseSchema,
        paginated: true,
      },
      handler: (ctx) => controller.list(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/audit-logs/:id',
      tags: TAGS,
      summary: 'Get an audit log entry',
      roles: ADMIN,
      params: auditIdParams,
      response: { status: 200, description: 'Audit entry', data: auditLogResponseSchema },
      handler: (ctx) => controller.getById(ctx),
    }),
  ];
}
