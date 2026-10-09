import { z } from 'zod';
import { Role, ROLES } from '../common/enums/role.enum';
import { protectedRoute, type RouteDefinition } from '../common/http/route';
import { positiveId } from '../common/validation/primitives';
import { type MachinePartsController } from './machine-parts.controller';
import {
  createMachinePartSchema,
  listMachinePartsQuerySchema,
  machinePartResponseSchema,
  updateMachinePartSchema,
} from './machine-parts.dto';

const PART_TAGS = ['Machine parts'];
const ADMIN = [Role.ADMIN] as const;

const machineParams = z.object({ machineId: positiveId });
const partParams = z.object({ machineId: positiveId, partId: positiveId });

export function machinePartsRoutes(controller: MachinePartsController): RouteDefinition[] {
  return [
    protectedRoute({
      method: 'post',
      path: '/machines/:machineId/parts',
      tags: PART_TAGS,
      summary: 'Add a part to a machine',
      description:
        'Parts start ACTIVE unless another valid starting status is given. `isCritical` sets the default ' +
        "operational impact of future conditions. The machine's operational status is recalculated.",
      roles: ADMIN,
      params: machineParams,
      body: createMachinePartSchema,
      response: { status: 201, description: 'Part created', data: machinePartResponseSchema },
      errors: [409, 422],
      handler: (ctx) => controller.create(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/machines/:machineId/parts',
      tags: PART_TAGS,
      summary: 'List the parts of a machine',
      roles: ROLES,
      params: machineParams,
      query: listMachinePartsQuerySchema,
      response: {
        status: 200,
        description: 'Paginated parts',
        data: machinePartResponseSchema,
        paginated: true,
      },
      handler: (ctx) => controller.list(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/machines/:machineId/parts/:partId',
      tags: PART_TAGS,
      summary: 'Get a machine part',
      roles: ROLES,
      params: partParams,
      response: { status: 200, description: 'Part', data: machinePartResponseSchema },
      handler: (ctx) => controller.getById(ctx),
    }),
    protectedRoute({
      method: 'patch',
      path: '/machines/:machineId/parts/:partId',
      tags: PART_TAGS,
      summary: 'Update part details or criticality',
      description:
        'Status and operational impact cannot be set here; they change only through part logs ' +
        '(POST /machine-logs with machinePartId). ' +
        'Changing criticality or deactivating a part recalculates the machine status.',
      roles: ADMIN,
      params: partParams,
      body: updateMachinePartSchema,
      response: { status: 200, description: 'Updated part', data: machinePartResponseSchema },
      errors: [409],
      handler: (ctx) => controller.update(ctx),
    }),
    protectedRoute({
      method: 'delete',
      path: '/machines/:machineId/parts/:partId',
      tags: PART_TAGS,
      summary: 'Delete (soft) a machine part',
      description: 'Refused while the part has open logs. History is preserved.',
      roles: ADMIN,
      params: partParams,
      response: { status: 200, description: 'Part deleted' },
      errors: [409],
      handler: (ctx) => controller.remove(ctx),
    }),
  ];
}
