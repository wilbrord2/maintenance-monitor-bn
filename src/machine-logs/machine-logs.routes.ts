import { Role, ROLES } from '../common/enums/role.enum';
import { protectedRoute, type RouteDefinition } from '../common/http/route';
import { idParams } from '../common/validation/primitives';
import { type MachineLogsController } from './machine-logs.controller';
import {
  createMachineLogSchema,
  listMachineLogsQuerySchema,
  machineHistoryQuerySchema,
  machineLogResponseSchema,
  stateTransitionsResponseSchema,
  updateMachineLogSchema,
} from './machine-logs.dto';

const TAGS = ['Machine logs'];

export function machineLogsRoutes(controller: MachineLogsController): RouteDefinition[] {
  return [
    protectedRoute({
      method: 'post',
      path: '/machine-logs',
      tags: TAGS,
      summary: 'Record a maintenance/fault log (updates machine status)',
      description:
        'Atomically creates the log, sets the machine status to `resultingState` and writes audit entries. ' +
        '`entryStatus` must match the current machine status (409 MACHINE_STATE_CONFLICT otherwise) and the ' +
        'transition must be allowed (422 INVALID_STATE_TRANSITION). Emits `machine.status.updated` on change.',
      roles: ROLES,
      body: createMachineLogSchema,
      response: { status: 201, description: 'Log created', data: machineLogResponseSchema },
      errors: [404, 409, 422],
      handler: (ctx) => controller.create(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/machine-logs',
      tags: TAGS,
      summary: 'List machine logs',
      description:
        'Filter by machineId, userId, entryStatus, resultingState, logStatus and a startedAt date range.',
      roles: ROLES,
      query: listMachineLogsQuerySchema,
      response: {
        status: 200,
        description: 'Paginated logs',
        data: machineLogResponseSchema,
        paginated: true,
      },
      handler: (ctx) => controller.list(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/machine-logs/:id',
      tags: TAGS,
      summary: 'Get a machine log',
      roles: ROLES,
      params: idParams,
      response: { status: 200, description: 'Log', data: machineLogResponseSchema },
      handler: (ctx) => controller.getById(ctx),
    }),
    protectedRoute({
      method: 'patch',
      path: '/machine-logs/:id',
      tags: TAGS,
      summary: 'Update a machine log',
      description:
        'Requires the current `version` (409 STALE_VERSION if outdated). `resultingState` may only change on the ' +
        "machine's most recent log, and updates the machine status in the same transaction.",
      roles: ROLES,
      params: idParams,
      body: updateMachineLogSchema,
      response: { status: 200, description: 'Updated log', data: machineLogResponseSchema },
      errors: [409, 422],
      handler: (ctx) => controller.update(ctx),
    }),
    protectedRoute({
      method: 'delete',
      path: '/machine-logs/:id',
      tags: TAGS,
      summary: 'Delete (soft) a machine log',
      description: "Deleting a machine's most recent log reverts the machine to that log's entry status.",
      roles: [Role.ADMIN],
      params: idParams,
      response: { status: 200, description: 'Log deleted' },
      handler: (ctx) => controller.remove(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/machines/:id/logs',
      tags: ['Machines', ...TAGS],
      summary: 'Machine activity history',
      description: 'Newest first by default (createdAt DESC).',
      roles: ROLES,
      params: idParams,
      query: machineHistoryQuerySchema,
      response: {
        status: 200,
        description: 'Paginated history',
        data: machineLogResponseSchema,
        paginated: true,
      },
      handler: (ctx) => controller.history(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/machines/state-transitions',
      tags: ['Machines', ...TAGS],
      summary: 'Allowed machine state transitions and log status rules',
      roles: ROLES,
      response: { status: 200, description: 'Transition rules', data: stateTransitionsResponseSchema },
      handler: () => controller.stateTransitions(),
    }),
  ];
}
