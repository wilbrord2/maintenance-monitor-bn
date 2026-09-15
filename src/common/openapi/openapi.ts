import {
  OpenApiGeneratorV31,
  OpenAPIRegistry,
  type ResponseConfig,
  type RouteConfig,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ROLES } from '../enums/role.enum';
import { type DocumentedErrorStatus, type RouteDefinition } from '../http/route';

export const API_PREFIX = '/api/v1';

const paginationMetaSchema = z
  .object({
    page: z.number().int(),
    limit: z.number().int(),
    totalItems: z.number().int(),
    totalPages: z.number().int(),
  })
  .meta({ id: 'PaginationMeta' });

const errorResponseSchema = z
  .object({
    success: z.literal(false),
    message: z.string().meta({ example: 'Machine serial number already exists' }),
    code: z.string().meta({ example: 'MACHINE_SERIAL_EXISTS' }),
    timestamp: z.iso.datetime(),
    path: z.string().meta({ example: '/api/v1/machines' }),
    requestId: z.string().optional(),
    details: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
  })
  .meta({ id: 'ErrorResponse' });

const ERROR_DESCRIPTIONS: Record<DocumentedErrorStatus | 500, string> = {
  400: 'Validation failed or malformed request',
  401: 'Missing, invalid, expired or revoked credentials',
  403: 'Authenticated but not permitted (role, or temporary password must be changed)',
  404: 'Resource not found',
  409: 'Conflict with the current state (duplicate value or stale update)',
  422: 'Business rule violation',
  423: 'Account temporarily locked',
  429: 'Too many requests',
  503: 'Service unavailable',
  500: 'Unexpected server error',
};

function toOpenApiPath(path: string): string {
  return `${API_PREFIX}${path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`;
}

function successSchema(route: RouteDefinition): z.ZodType {
  const { data, paginated } = route.spec.response;
  const dataSchema = data ?? z.null();
  return z.object({
    success: z.literal(true),
    message: z.string(),
    data: paginated ? z.array(dataSchema) : dataSchema,
    ...(paginated ? { meta: paginationMetaSchema } : {}),
  });
}

function errorStatuses(route: RouteDefinition): (DocumentedErrorStatus | 500)[] {
  const statuses = new Set<DocumentedErrorStatus | 500>(route.spec.errors ?? []);
  if (route.spec.params || route.spec.query || route.spec.body) statuses.add(400);
  if (route.access.kind === 'protected') {
    statuses.add(401);
    statuses.add(403);
  }
  if (route.spec.params) statuses.add(404);
  statuses.add(429);
  statuses.add(500);
  return [...statuses].sort((a, b) => a - b);
}

function describeAccess(route: RouteDefinition): string {
  if (route.access.kind === 'public') return '**Access:** public';
  const roles =
    route.access.roles.length === ROLES.length ? 'any authenticated role' : route.access.roles.join(', ');
  return `**Access:** ${roles}`;
}

export interface OpenApiInfo {
  readonly version: string;
  readonly serverUrl?: string;
}

export function buildOpenApiDocument(routes: readonly RouteDefinition[], info: OpenApiInfo) {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Short-lived access token from POST /auth/login or /auth/refresh',
  });

  for (const route of routes) {
    const { spec } = route;
    const responses: Record<string, ResponseConfig> = {
      [spec.response.status]: {
        description: spec.response.description,
        content: { 'application/json': { schema: successSchema(route) } },
      },
    };
    for (const status of errorStatuses(route)) {
      responses[status] = {
        description: ERROR_DESCRIPTIONS[status],
        content: { 'application/json': { schema: errorResponseSchema } },
      };
    }

    const request: NonNullable<RouteConfig['request']> = {};
    if (spec.params) request.params = spec.params as RouteConfigParams;
    if (spec.query) request.query = spec.query as RouteConfigParams;
    if (spec.body) request.body = { required: true, content: { 'application/json': { schema: spec.body } } };

    registry.registerPath({
      method: spec.method,
      path: toOpenApiPath(spec.path),
      tags: [...spec.tags],
      summary: spec.summary,
      description: [spec.description, describeAccess(route)].filter(Boolean).join('\n\n'),
      ...(route.access.kind === 'protected' ? { security: [{ bearerAuth: [] }] } : {}),
      request,
      responses,
    });
  }

  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Maintenance Monitor API',
      version: info.version,
      description:
        'Machine fleet maintenance monitoring: live machine status, maintenance/fault logs, analytics and audit.\n\n' +
        'All responses use a consistent envelope. Machine status is changed exclusively through machine-log operations.',
    },
    servers: [{ url: info.serverUrl ?? '/' }],
  });
}

type RouteConfigParams = NonNullable<NonNullable<RouteConfig['request']>['params']>;
