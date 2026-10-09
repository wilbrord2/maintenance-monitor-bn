import { z } from 'zod';
import { MaintenanceEventStatus, MaintenanceScheduleState } from '../common/enums/maintenance.enums';
import {
  isoDate,
  isoDateTime,
  multilineText,
  paginationQuery,
  positiveId,
  sortingQuery,
} from '../common/validation/primitives';
import { MAINTENANCE_EVENT_SORT_FIELDS } from './maintenance.repository';

export const maintenanceEventStatusSchema = z
  .enum(MaintenanceEventStatus)
  .meta({ id: 'MaintenanceEventStatus' });
export const maintenanceScheduleStateSchema = z
  .enum(MaintenanceScheduleState)
  .meta({ id: 'MaintenanceScheduleState' });

const intervalDays = z
  .number()
  .int()
  .min(1)
  .max(3650)
  .meta({ description: 'Days between maintenances', example: 15 });
const reminderDaysBefore = z
  .number()
  .int()
  .min(0)
  .max(3650)
  .meta({ description: 'How many days before the due date reminders start' });

/**
 * A schedule's first due date comes from the machine's history: with
 * `lastMaintenanceAt` it is that date plus the interval (not today plus the
 * interval). `nextMaintenanceAt` overrides it explicitly.
 */
export const createMaintenanceScheduleSchema = z
  .object({
    intervalDays,
    reminderDaysBefore: reminderDaysBefore.default(3),
    lastMaintenanceAt: isoDateTime
      .optional()
      .meta({ description: 'When the machine was last maintained, if known' }),
    nextMaintenanceAt: isoDateTime.optional().meta({ description: 'Explicit first due date' }),
  })
  .strict()
  .refine(
    (value) => value.reminderDaysBefore <= value.intervalDays,
    'reminderDaysBefore cannot exceed intervalDays',
  )
  .meta({ id: 'CreateMaintenanceScheduleRequest' });
export type CreateMaintenanceScheduleDto = z.output<typeof createMaintenanceScheduleSchema>;

export const updateMaintenanceScheduleSchema = z
  .object({
    intervalDays: intervalDays.optional(),
    reminderDaysBefore: reminderDaysBefore.optional(),
    lastMaintenanceAt: isoDateTime.nullable().optional(),
    nextMaintenanceAt: isoDateTime.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided')
  .meta({ id: 'UpdateMaintenanceScheduleRequest' });
export type UpdateMaintenanceScheduleDto = z.output<typeof updateMaintenanceScheduleSchema>;

export const createMaintenanceEventSchema = z
  .object({
    machineId: z.number().int().positive(),
    scheduledFor: isoDateTime.optional().meta({ description: 'Defaults to the schedule due date, or now' }),
    notes: multilineText(1, 2000).optional(),
  })
  .strict()
  .meta({ id: 'CreateMaintenanceEventRequest' });
export type CreateMaintenanceEventDto = z.output<typeof createMaintenanceEventSchema>;

export const updateMaintenanceEventSchema = z
  .object({
    scheduledFor: isoDateTime.optional(),
    notes: multilineText(1, 2000).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided')
  .meta({ id: 'UpdateMaintenanceEventRequest' });
export type UpdateMaintenanceEventDto = z.output<typeof updateMaintenanceEventSchema>;

export const startMaintenanceEventSchema = z
  .object({
    notes: multilineText(1, 2000).optional(),
    putMachineUnderMaintenance: z.boolean().default(true).meta({
      description:
        'Opens a machine log that moves the machine to UNDER_MAINTENANCE through the existing machine workflow.',
    }),
  })
  .strict()
  .meta({ id: 'StartMaintenanceEventRequest' });
export type StartMaintenanceEventDto = z.output<typeof startMaintenanceEventSchema>;

export const completeMaintenanceEventSchema = z
  .object({
    completedAt: isoDateTime.optional().meta({ description: 'Actual completion time; defaults to now' }),
    notes: multilineText(1, 2000).optional(),
    releaseMachine: z.boolean().default(true).meta({
      description: 'Closes the machine log opened at start, returning the machine to ACTIVE.',
    }),
  })
  .strict()
  .meta({ id: 'CompleteMaintenanceEventRequest' });
export type CompleteMaintenanceEventDto = z.output<typeof completeMaintenanceEventSchema>;

export const cancelMaintenanceEventSchema = z
  .object({ reason: multilineText(1, 2000).optional() })
  .strict()
  .meta({ id: 'CancelMaintenanceEventRequest' });
export type CancelMaintenanceEventDto = z.output<typeof cancelMaintenanceEventSchema>;

export const listMaintenanceEventsQuerySchema = paginationQuery
  .extend(sortingQuery(MAINTENANCE_EVENT_SORT_FIELDS, 'scheduledFor').shape)
  .extend({
    machineId: positiveId.optional(),
    maintenanceScheduleId: positiveId.optional(),
    status: maintenanceEventStatusSchema.optional(),
    performedById: positiveId.optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.from && value.to && value.from > value.to) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'must be on or after from' });
    }
  });
export type ListMaintenanceEventsQuery = z.output<typeof listMaintenanceEventsQuerySchema>;

export const maintenanceDashboardQuerySchema = paginationQuery.strict();
export type MaintenanceDashboardQuery = z.output<typeof maintenanceDashboardQuerySchema>;

const machineSummarySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  serialNumber: z.string(),
});

export const maintenanceScheduleResponseSchema = z
  .object({
    id: z.number().int(),
    machineId: z.number().int(),
    machine: machineSummarySchema.nullable(),
    intervalDays: z.number().int(),
    reminderDaysBefore: z.number().int(),
    lastMaintenanceAt: z.iso.datetime().nullable(),
    nextMaintenanceAt: z.iso.datetime(),
    isActive: z.boolean(),
    state: maintenanceScheduleStateSchema,
    daysUntilDue: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'MaintenanceSchedule' });

export const maintenanceEventResponseSchema = z
  .object({
    id: z.number().int(),
    maintenanceScheduleId: z.number().int().nullable(),
    machine: machineSummarySchema.nullable(),
    performedBy: z
      .object({ id: z.number().int(), fullName: z.string(), position: z.string().nullable() })
      .nullable(),
    machineLogId: z.number().int().nullable(),
    scheduledFor: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    status: maintenanceEventStatusSchema,
    notes: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'MaintenanceEvent' });
