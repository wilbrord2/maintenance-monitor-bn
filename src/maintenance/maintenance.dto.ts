import { z } from 'zod';
import { MaintenanceEventStatus, MaintenanceScheduleState } from '../common/enums/maintenance.enums';
import {
  booleanQuery,
  isoDate,
  isoDateTime,
  multilineText,
  paginationQuery,
  positiveId,
  sortingQuery,
  text,
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
  .meta({ description: 'Days between maintenances (daily = 1, weekly = 7, monthly = 30)', example: 7 });
const reminderDaysBefore = z
  .number()
  .int()
  .min(0)
  .max(3650)
  .meta({ description: 'How many days before the due date reminders start' });
const taskName = text(1, 160).meta({ example: 'Cutting head inspection' });
const scheduleDescription = multilineText(1, 2000).meta({ example: 'Check nozzle, lens and ceramic ring' });

export const maintenanceScheduleScopeSchema = z
  .enum(['machine', 'part'])
  .meta({ id: 'MaintenanceScheduleScope', description: '`machine`: machine-wide tasks; `part`: part tasks' });

/**
 * A schedule is a recurring task for one part (`machinePartId`) or for the
 * whole machine. Its first due date comes from the history: with
 * `lastMaintenanceAt` it is that date plus the interval (not today plus the
 * interval). `nextMaintenanceAt` overrides it explicitly.
 */
export const createMaintenanceScheduleSchema = z
  .object({
    machinePartId: z.number().int().positive().optional().meta({
      description: 'The part this task inspects. Omit for a machine-wide task (e.g. cleaning).',
    }),
    taskName: taskName.optional().meta({
      description: "Defaults to the part's name for part tasks; required for machine-wide tasks.",
    }),
    description: scheduleDescription.optional(),
    intervalDays,
    reminderDaysBefore: reminderDaysBefore.optional().meta({
      description: 'Defaults to 3, capped at intervalDays - 1 (so 0 for daily tasks)',
    }),
    lastMaintenanceAt: isoDateTime
      .optional()
      .meta({ description: 'When this task was last performed, if known' }),
    nextMaintenanceAt: isoDateTime.optional().meta({ description: 'Explicit first due date' }),
  })
  .strict()
  .refine((value) => value.machinePartId !== undefined || value.taskName !== undefined, {
    path: ['taskName'],
    message: 'is required for machine-wide tasks',
  })
  .refine(
    (value) => value.reminderDaysBefore === undefined || value.reminderDaysBefore <= value.intervalDays,
    { path: ['reminderDaysBefore'], message: 'cannot exceed intervalDays' },
  )
  .meta({ id: 'CreateMaintenanceScheduleRequest' });
export type CreateMaintenanceScheduleDto = z.output<typeof createMaintenanceScheduleSchema>;

export const updateMaintenanceScheduleSchema = z
  .object({
    taskName: taskName.optional(),
    description: scheduleDescription.nullable().optional(),
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

/**
 * Planned maintenance references its schedule (machine and part come from it);
 * one-off maintenance names the machine and, optionally, the part.
 */
export const createMaintenanceEventSchema = z
  .object({
    maintenanceScheduleId: z.number().int().positive().optional().meta({
      description: 'The recurring task this event performs. Omit for one-off maintenance.',
    }),
    machineId: z.number().int().positive().optional().meta({
      description: 'One-off maintenance only: the machine maintained',
    }),
    machinePartId: z.number().int().positive().optional().meta({
      description: 'One-off maintenance only: the part maintained, if any',
    }),
    scheduledFor: isoDateTime.optional().meta({ description: 'Defaults to the schedule due date, or now' }),
    notes: multilineText(1, 2000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.maintenanceScheduleId !== undefined) {
      for (const field of ['machineId', 'machinePartId'] as const) {
        if (value[field] !== undefined) {
          ctx.addIssue({ code: 'custom', path: [field], message: 'is taken from the schedule; omit it' });
        }
      }
    } else if (value.machineId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['machineId'],
        message: 'is required when maintenanceScheduleId is omitted',
      });
    }
  })
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
    putUnderMaintenance: z
      .boolean()
      .default(true)
      .meta({
        description:
          'Opens a log that moves the subject to UNDER_MAINTENANCE through the existing machine workflow: a ' +
          'part log for part maintenance (the machine status is then re-derived from its parts), otherwise a ' +
          'machine log.',
      }),
  })
  .strict()
  .meta({ id: 'StartMaintenanceEventRequest' });
export type StartMaintenanceEventDto = z.output<typeof startMaintenanceEventSchema>;

export const completeMaintenanceEventSchema = z
  .object({
    completedAt: isoDateTime.optional().meta({ description: 'Actual completion time; defaults to now' }),
    notes: multilineText(1, 2000).optional(),
    releaseOnComplete: z.boolean().default(true).meta({
      description: 'Closes the log opened at start, returning the part (or machine) to ACTIVE.',
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
    machinePartId: positiveId.optional(),
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

const scheduleFilters = {
  machinePartId: positiveId.optional(),
  scope: maintenanceScheduleScopeSchema.optional(),
};

export const listMaintenanceSchedulesQuerySchema = z
  .object({ ...scheduleFilters, isActive: booleanQuery.optional() })
  .strict();
export type ListMaintenanceSchedulesQuery = z.output<typeof listMaintenanceSchedulesQuerySchema>;

export const maintenanceDashboardQuerySchema = paginationQuery
  .extend({ machineId: positiveId.optional(), ...scheduleFilters })
  .strict();
export type MaintenanceDashboardQuery = z.output<typeof maintenanceDashboardQuerySchema>;

const machineSummarySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  serialNumber: z.string(),
});

const machinePartSummarySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  partCode: z.string(),
});

export const maintenanceScheduleResponseSchema = z
  .object({
    id: z.number().int(),
    machineId: z.number().int(),
    machine: machineSummarySchema.nullable(),
    machinePartId: z.number().int().nullable(),
    machinePart: machinePartSummarySchema.nullable(),
    taskName: z.string(),
    description: z.string().nullable(),
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
    taskName: z
      .string()
      .nullable()
      .meta({ description: 'Task of the schedule; null for one-off maintenance' }),
    machine: machineSummarySchema.nullable(),
    machinePartId: z.number().int().nullable(),
    machinePart: machinePartSummarySchema.nullable(),
    performedBy: z
      .object({ id: z.number().int(), fullName: z.string(), position: z.string().nullable() })
      .nullable(),
    machineLogId: z.number().int().nullable().meta({ description: 'Machine or part log opened at start' }),
    scheduledFor: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    status: maintenanceEventStatusSchema,
    notes: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'MaintenanceEvent' });
