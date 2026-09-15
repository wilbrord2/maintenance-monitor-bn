import { Role, ROLES } from '../common/enums/role.enum';
import { protectedRoute, type RouteDefinition } from '../common/http/route';
import { idParams } from '../common/validation/primitives';
import { type MachinesController } from './machines.controller';
import {
  createMachineSchema,
  listMachinesQuerySchema,
  machineResponseSchema,
  updateMachineSchema,
} from './machines.dto';

const TAGS = ['Machines'];
const ADMIN = [Role.ADMIN] as const;
const STATUS_NOTE = 'Machine status cannot be set here; it changes only through machine-log operations.';

export function machinesRoutes(controller: MachinesController): RouteDefinition[] {
  return [
    protectedRoute({
      method: 'post',
      path: '/machines',
      tags: TAGS,
      summary: 'Create a machine',
      description: `New machines start with status ACTIVE. ${STATUS_NOTE}`,
      roles: ADMIN,
      body: createMachineSchema,
      response: { status: 201, description: 'Machine created', data: machineResponseSchema },
      errors: [409],
      handler: (ctx) => controller.create(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/machines',
      tags: TAGS,
      summary: 'List machines (status board)',
      roles: ROLES,
      query: listMachinesQuerySchema,
      response: {
        status: 200,
        description: 'Paginated machines',
        data: machineResponseSchema,
        paginated: true,
      },
      handler: (ctx) => controller.list(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/machines/:id',
      tags: TAGS,
      summary: 'Get a machine',
      roles: ROLES,
      params: idParams,
      response: { status: 200, description: 'Machine', data: machineResponseSchema },
      handler: (ctx) => controller.getById(ctx),
    }),
    protectedRoute({
      method: 'patch',
      path: '/machines/:id',
      tags: TAGS,
      summary: 'Update machine details',
      description: STATUS_NOTE,
      roles: ADMIN,
      params: idParams,
      body: updateMachineSchema,
      response: { status: 200, description: 'Updated machine', data: machineResponseSchema },
      errors: [409],
      handler: (ctx) => controller.update(ctx),
    }),
    protectedRoute({
      method: 'post',
      path: '/machines/:id/deactivate',
      tags: TAGS,
      summary: 'Deactivate a machine (no new logs can be recorded)',
      roles: ADMIN,
      params: idParams,
      response: { status: 200, description: 'Deactivated machine', data: machineResponseSchema },
      handler: (ctx) => controller.deactivate(ctx),
    }),
    protectedRoute({
      method: 'post',
      path: '/machines/:id/activate',
      tags: TAGS,
      summary: 'Reactivate a machine',
      roles: ADMIN,
      params: idParams,
      response: { status: 200, description: 'Activated machine', data: machineResponseSchema },
      handler: (ctx) => controller.activate(ctx),
    }),
    protectedRoute({
      method: 'delete',
      path: '/machines/:id',
      tags: TAGS,
      summary: 'Delete (soft) a machine',
      description: 'Refused while the machine has open logs. History is preserved.',
      roles: ADMIN,
      params: idParams,
      response: { status: 200, description: 'Machine deleted' },
      errors: [409],
      handler: (ctx) => controller.remove(ctx),
    }),
  ];
}
