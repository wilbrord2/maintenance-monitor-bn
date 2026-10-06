import { Role, ROLES } from '../common/enums/role.enum';
import { protectedRoute, type RouteDefinition } from '../common/http/route';
import { z } from 'zod';
import { idParams, positiveId } from '../common/validation/primitives';
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
const partIdParams = z.object({ partId: positiveId });

export function machineLogsRoutes(controller: MachineLogsController): RouteDefinition[] {
  return [
    protectedRoute({
      method: 'post',
      path: '/machine-logs',
      tags: TAGS,
      summary: 'Record a machine or part event (updates machine status)',
      description:
        'One endpoint for every machine event. Without `machinePartId` the log concerns the whole machine ' +
        'system; with it, the log concerns that part. Atomically creates the log, applies `resultingState` to ' +
        'its subject, re-derives the machine status from its system status and all its parts, and writes ' +
        'audit entries. `entryStatus` is optional; when sent it must match the subject (409 ' +
        'MACHINE_STATE_CONFLICT / MACHINE_PART_STATE_CONFLICT otherwise). The transition must be allowed ' +
        '(422 INVALID_STATE_TRANSITION). Emits `machine.part.updated`, `machine.status.updated` and ' +
        '`machine.operational-status.updated` as applicable.',
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
        'Filter by machineId, scope, machinePartId, operationalImpact, userId, entryStatus, resultingState, ' +
        'logStatus and a startedAt date range.',
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
        "subject's most recent log (machine system or part), and re-derives the machine status in the same " +
        'transaction.',
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
      description:
        "Deleting the most recent log of a subject (machine system or part) reverts it to that log's entry " +
        'status and re-derives the machine status.',
      roles: [Role.ADMIN],
      params: idParams,
      response: { status: 200, description: 'Log deleted' },
      handler: (ctx) => controller.remove(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/machines/:id/logs',
      tags: ['Machines', ...TAGS],
      summary: 'Machine activity history (whole-machine and part events)',
      description: 'Newest first by default (createdAt DESC). Filter with `scope` or `machinePartId`.',
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
      path: '/machine-parts/:partId/logs',
      tags: ['Machine parts', ...TAGS],
      summary: 'Part history (newest first)',
      description: 'The machine logs concerning this part.',
      roles: ROLES,
      params: partIdParams,
      query: machineHistoryQuerySchema,
      response: {
        status: 200,
        description: 'Paginated part history',
        data: machineLogResponseSchema,
        paginated: true,
      },
      handler: (ctx) => controller.partHistory(ctx),
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
