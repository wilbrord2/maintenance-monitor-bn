import { z } from 'zod';
import { MachineOperationalStatus } from '../common/enums/machine-operational-status.enum';
import { MachineState } from '../common/enums/machine-state.enum';
import { machinePartResponseSchema } from '../machine-parts/machine-parts.dto';
import { maintenanceScheduleResponseSchema } from '../maintenance/maintenance.dto';
import {
  booleanQuery,
  multilineText,
  paginationQuery,
  searchQuery,
  sortingQuery,
  text,
} from '../common/validation/primitives';
import { MACHINE_SORT_FIELDS } from './machines.repository';

export const machineStateSchema = z.enum(MachineState).meta({ id: 'MachineState' });
export const machineOperationalStatusSchema = z
  .enum(MachineOperationalStatus)
  .meta({ id: 'MachineOperationalStatus' });

const serialNumber = z
  .string()
  .trim()
  .toUpperCase()
  .min(1, 'must not be empty')
  .max(64, 'must be at most 64 characters')
  .regex(/^[A-Z0-9][A-Z0-9._/-]*$/, 'may contain only letters, digits, ".", "_", "/" and "-"')
  .meta({ example: 'LSR-2024-0001' });

/**
 * Machine status is intentionally absent: new machines start ACTIVE and
 * status only changes through machine logs (whole-machine or part). `.strict()` rejects it.
 */
export const createMachineSchema = z
  .object({
    name: text(1, 120).meta({ example: 'Laser 1' }),
    serialNumber,
    description: multilineText(1, 2000).optional(),
  })
  .strict()
  .meta({ id: 'CreateMachineRequest' });
export type CreateMachineDto = z.output<typeof createMachineSchema>;

export const updateMachineSchema = z
  .object({
    name: text(1, 120).optional(),
    serialNumber: serialNumber.optional(),
    description: multilineText(1, 2000).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided')
  .meta({ id: 'UpdateMachineRequest' });
export type UpdateMachineDto = z.output<typeof updateMachineSchema>;

export const listMachinesQuerySchema = paginationQuery
  .extend(sortingQuery(MACHINE_SORT_FIELDS, 'name', 'asc').shape)
  .extend({
    status: machineStateSchema.optional(),
    operationalStatus: machineOperationalStatusSchema.optional(),
    isActive: booleanQuery.optional(),
    search: searchQuery,
  })
  .strict();
export type ListMachinesQuery = z.output<typeof listMachinesQuerySchema>;

export const machineResponseSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    serialNumber: z.string(),
    status: machineStateSchema.meta({
      description: 'Effective status: the most severe of systemStatus and the status of each active part',
    }),
    systemStatus: machineStateSchema.meta({
      description: 'State of the machine as a whole system, set by whole-machine logs',
    }),
    operationalStatus: machineOperationalStatusSchema,
    description: z.string().nullable(),
    isActive: z.boolean(),
    activity: z.object({
      totalLogs: z.number().int(),
      openLogs: z.number().int(),
      lastActivityAt: z.iso.datetime().nullable(),
    }),
    parts: z.object({
      total: z.number().int(),
      active: z.number().int(),
      underMaintenance: z.number().int(),
      downtime: z.number().int(),
      underTest: z.number().int(),
      blocking: z.number().int(),
      critical: z.number().int(),
    }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Machine' });

/** Machine details also carry the part conditions and every maintenance task (machine-wide and per part). */
export const machineDetailResponseSchema = machineResponseSchema
  .extend({
    partDetails: z.array(machinePartResponseSchema),
    maintenanceSchedules: z.array(maintenanceScheduleResponseSchema),
  })
  .meta({ id: 'MachineDetail' });
