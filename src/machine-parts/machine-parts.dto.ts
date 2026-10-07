import { z } from 'zod';
import { MachinePartStatus } from '../common/enums/machine-part-status.enum';
import { OperationalImpact } from '../common/enums/operational-impact.enum';
import {
  booleanQuery,
  multilineText,
  paginationQuery,
  searchQuery,
  sortingQuery,
  text,
} from '../common/validation/primitives';
import { maintenanceScheduleStateSchema } from '../maintenance/maintenance.dto';
import { MACHINE_PART_SORT_FIELDS } from './machine-parts.repository';

/** Parts reuse the four machine statuses (ACTIVE, UNDER_MAINTENANCE, DOWNTIME, UNDER_TEST). */
export const machinePartStatusSchema = z.enum(MachinePartStatus).meta({ id: 'MachinePartStatus' });
export const operationalImpactSchema = z.enum(OperationalImpact).meta({ id: 'OperationalImpact' });

const partCode = z
  .string()
  .trim()
  .toUpperCase()
  .min(1, 'must not be empty')
  .max(64, 'must be at most 64 characters')
  .regex(/^[A-Z0-9][A-Z0-9._/-]*$/, 'may contain only letters, digits, ".", "_", "/" and "-"')
  .meta({ example: 'A1' });

/**
 * Parts start ACTIVE unless an administrator configures another valid starting
 * state. Status is otherwise changed only through part logs (machine logs with a machinePartId).
 */
export const createMachinePartSchema = z
  .object({
    name: text(1, 120).meta({ example: 'Hydraulic pump' }),
    partCode,
    description: multilineText(1, 2000).optional(),
    isCritical: z
      .boolean()
      .default(false)
      .meta({ description: 'Whether this part failing normally stops the machine' }),
    status: machinePartStatusSchema
      .default(MachinePartStatus.ACTIVE)
      .meta({ description: 'Starting status; defaults to ACTIVE' }),
    operationalImpact: operationalImpactSchema
      .optional()
      .meta({ description: 'Impact of a non-ACTIVE starting status; defaults from isCritical' }),
  })
  .strict()
  .meta({ id: 'CreateMachinePartRequest' });
export type CreateMachinePartDto = z.output<typeof createMachinePartSchema>;

/** Status and impact are absent on purpose: they change through part logs only. */
export const updateMachinePartSchema = z
  .object({
    name: text(1, 120).optional(),
    partCode: partCode.optional(),
    description: multilineText(1, 2000).nullable().optional(),
    isCritical: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided')
  .meta({ id: 'UpdateMachinePartRequest' });
export type UpdateMachinePartDto = z.output<typeof updateMachinePartSchema>;

export const listMachinePartsQuerySchema = paginationQuery
  .extend(sortingQuery(MACHINE_PART_SORT_FIELDS, 'partCode', 'asc').shape)
  .extend({
    status: machinePartStatusSchema.optional(),
    isCritical: booleanQuery.optional(),
    isActive: booleanQuery.optional(),
    search: searchQuery,
  })
  .strict();
export type ListMachinePartsQuery = z.output<typeof listMachinePartsQuerySchema>;

export const machinePartResponseSchema = z
  .object({
    id: z.number().int(),
    machineId: z.number().int(),
    name: z.string(),
    partCode: z.string(),
    description: z.string().nullable(),
    status: machinePartStatusSchema,
    operationalImpact: operationalImpactSchema,
    isCritical: z.boolean(),
    isActive: z.boolean(),
    hasDefect: z.boolean(),
    isBlockingMachine: z.boolean(),
    nextMaintenance: z
      .object({
        scheduleId: z.number().int(),
        taskName: z.string(),
        intervalDays: z.number().int(),
        nextMaintenanceAt: z.iso.datetime(),
        state: maintenanceScheduleStateSchema,
        daysUntilDue: z.number().int(),
      })
      .nullable()
      .meta({ description: "The part's earliest-due active maintenance task; null when none" }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'MachinePart' });
