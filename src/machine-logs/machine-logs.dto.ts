import { z } from 'zod';
import { LogScope } from '../common/enums/log-scope.enum';
import { LogStatus } from '../common/enums/log-status.enum';
import {
  isoDate,
  isoDateTime,
  multilineText,
  paginationQuery,
  positiveId,
  searchQuery,
  sortingQuery,
} from '../common/validation/primitives';
import { operationalImpactSchema } from '../machine-parts/machine-parts.dto';
import { machineOperationalStatusSchema, machineStateSchema } from '../machines/machines.dto';
import { MACHINE_LOG_SORT_FIELDS } from './machine-logs.repository';

export const logStatusSchema = z.enum(LogStatus).meta({ id: 'LogStatus' });
export const logScopeSchema = z.enum(LogScope).meta({ id: 'LogScope' });

const MAX_DOWNTIME_HOURS = 99_999_999;

const downtimeHours = z
  .number()
  .min(0, 'cannot be negative')
  .max(MAX_DOWNTIME_HOURS)
  .meta({ description: 'Hours of downtime. Calculated from startedAt/endedAt when omitted.', example: 2.5 });

/**
 * One endpoint records every machine event. Without `machinePartId` the log
 * concerns the whole machine system; with it, the log concerns that part.
 */
export const createMachineLogSchema = z
  .object({
    machineId: z.number().int().positive(),
    machinePartId: z
      .number()
      .int()
      .positive()
      .optional()
      .meta({
        description:
          'The part this event concerns. Omit to log the whole machine system. Machines with parts derive ' +
          'their status from them, so part faults should be logged against the part.',
      }),
    faultDescription: multilineText(1, 2000).meta({ example: 'Hydraulic pressure drop on main cylinder' }),
    causeDescription: multilineText(1, 2000).optional().meta({ example: 'Worn seal' }),
    entryStatus: machineStateSchema.optional().meta({
      description:
        "Current state of the subject (the machine system, or the part). Defaults to the server's current " +
        'value; when sent it must match, otherwise 409 MACHINE_STATE_CONFLICT / MACHINE_PART_STATE_CONFLICT.',
    }),
    remedyAction: multilineText(1, 2000).optional().meta({ example: 'Replaced seal kit' }),
    resultingState: machineStateSchema.meta({
      description:
        'State of the subject after this event. The machine status is then recalculated from its ' +
        'system state and all its parts.',
    }),
    operationalImpact: operationalImpactSchema.optional().meta({
      description:
        "Part logs only: whether the resulting part condition stops the machine. Defaults from the part's " +
        'isCritical flag; always NON_BLOCKING when the part returns to ACTIVE.',
    }),
    downtimeHours: downtimeHours.optional(),
    logStatus: logStatusSchema.default(LogStatus.OPEN),
    nextMaintenancePlan: multilineText(1, 1000).optional().meta({ example: 'Re-check in 2 weeks' }),
    startedAt: isoDateTime.optional().meta({ description: 'Defaults to now' }),
    endedAt: isoDateTime.optional().meta({ description: 'Defaults to now when the log is CLOSED' }),
  })
  .strict()
  .refine((value) => value.operationalImpact === undefined || value.machinePartId !== undefined, {
    path: ['operationalImpact'],
    message: 'is only allowed on part logs (machinePartId)',
  })
  .meta({ id: 'CreateMachineLogRequest' });
export type CreateMachineLogDto = z.output<typeof createMachineLogSchema>;

/** machineId, machinePartId, entryStatus and author are immutable history and therefore not accepted. */
export const updateMachineLogSchema = z
  .object({
    version: z
      .number()
      .int()
      .min(1)
      .meta({ description: 'The version last read; stale versions are rejected (409).' }),
    faultDescription: multilineText(1, 2000).optional(),
    causeDescription: multilineText(1, 2000).nullable().optional(),
    remedyAction: multilineText(1, 2000).nullable().optional(),
    resultingState: machineStateSchema.optional().meta({
      description:
        "Only allowed on the subject's most recent log (machine system or part); recalculates the machine status.",
    }),
    operationalImpact: operationalImpactSchema.optional().meta({ description: 'Part logs only' }),
    downtimeHours: downtimeHours.optional(),
    logStatus: logStatusSchema.optional(),
    nextMaintenancePlan: multilineText(1, 1000).nullable().optional(),
    startedAt: isoDateTime.optional(),
    endedAt: isoDateTime.nullable().optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'version'),
    'At least one field must be provided',
  )
  .meta({ id: 'UpdateMachineLogRequest' });
export type UpdateMachineLogDto = z.output<typeof updateMachineLogSchema>;

const dateBoundsRefinement = (
  value: { from?: string | undefined; to?: string | undefined },
  ctx: z.RefinementCtx,
) => {
  if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'must be on or after from' });
  }
};

const logFilterFields = {
  scope: logScopeSchema.optional(),
  machinePartId: positiveId.optional(),
  operationalImpact: operationalImpactSchema.optional(),
  entryStatus: machineStateSchema.optional(),
  resultingState: machineStateSchema.optional(),
  logStatus: logStatusSchema.optional(),
  from: isoDate.optional().meta({ description: 'Inclusive start date (UTC) applied to startedAt' }),
  to: isoDate.optional().meta({ description: 'Inclusive end date (UTC) applied to startedAt' }),
  search: searchQuery,
};

export const listMachineLogsQuerySchema = paginationQuery
  .extend(sortingQuery(MACHINE_LOG_SORT_FIELDS, 'createdAt').shape)
  .extend({
    machineId: positiveId.optional(),
    userId: positiveId.optional(),
    ...logFilterFields,
  })
  .strict()
  .superRefine(dateBoundsRefinement);
export type ListMachineLogsQuery = z.output<typeof listMachineLogsQuerySchema>;

export const machineHistoryQuerySchema = paginationQuery
  .extend(sortingQuery(MACHINE_LOG_SORT_FIELDS, 'createdAt').shape)
  .extend({ userId: positiveId.optional(), ...logFilterFields })
  .strict()
  .superRefine(dateBoundsRefinement);
export type MachineHistoryQuery = z.output<typeof machineHistoryQuerySchema>;

export const machineLogResponseSchema = z
  .object({
    id: z.number().int(),
    machine: z.object({
      id: z.number().int(),
      name: z.string(),
      serialNumber: z.string(),
      status: machineStateSchema,
      systemStatus: machineStateSchema,
      operationalStatus: machineOperationalStatusSchema,
    }),
    scope: logScopeSchema,
    machinePart: z
      .object({ id: z.number().int(), partCode: z.string(), name: z.string(), isCritical: z.boolean() })
      .nullable(),
    technician: z.object({ id: z.number().int(), fullName: z.string(), position: z.string().nullable() }),
    faultDescription: z.string(),
    causeDescription: z.string().nullable(),
    entryStatus: machineStateSchema,
    remedyAction: z.string().nullable(),
    resultingState: machineStateSchema,
    operationalImpact: operationalImpactSchema.nullable(),
    machineStatusBefore: machineStateSchema,
    machineStatusAfter: machineStateSchema,
    operationalStatusBefore: machineOperationalStatusSchema,
    operationalStatusAfter: machineOperationalStatusSchema,
    downtimeHours: z.number(),
    logStatus: logStatusSchema,
    nextMaintenancePlan: z.string().nullable(),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'MachineLog' });

export const stateTransitionsResponseSchema = z
  .object({
    allowSameStateEntries: z.boolean(),
    transitions: z.record(z.string(), z.array(machineStateSchema)),
    statesRequiringOpenLog: z.array(machineStateSchema),
  })
  .meta({ id: 'MachineStateTransitions' });
