import { z } from 'zod';
import { isoDate } from '../common/validation/primitives';
import { MAX_ANALYTICS_DAYS } from './time-range';

const rangeFields = {
  days: z.coerce.number().int().min(1).max(MAX_ANALYTICS_DAYS).optional().meta({
    description: 'Rolling window ending now, e.g. 7, 30 or 90. Defaults to 30 when no range is given.',
  }),
  from: isoDate.optional().meta({ description: 'Calendar start date (UTC, inclusive). Requires `to`.' }),
  to: isoDate.optional().meta({ description: 'Calendar end date (UTC, inclusive). Requires `from`.' }),
};

const limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(100)
  .default(10)
  .meta({ description: 'Maximum rows (max 100)' });

export const analyticsRangeQuerySchema = z.object(rangeFields).strict();
export type AnalyticsRangeQuery = z.output<typeof analyticsRangeQuerySchema>;

export const analyticsTopQuerySchema = z.object({ ...rangeFields, limit }).strict();
export type AnalyticsTopQuery = z.output<typeof analyticsTopQuerySchema>;

export const analyticsFaultsQuerySchema = z
  .object({
    ...rangeFields,
    limit,
    minOccurrences: z.coerce
      .number()
      .int()
      .min(2)
      .max(1000)
      .default(2)
      .meta({ description: 'Occurrences of the same fault on one machine to count as recurring' }),
  })
  .strict();
export type AnalyticsFaultsQuery = z.output<typeof analyticsFaultsQuerySchema>;

const rangeSchema = z
  .object({ from: z.iso.datetime(), to: z.iso.datetime(), days: z.number().int() })
  .meta({ id: 'AnalyticsRange' });
const machineRefSchema = z.object({ id: z.number().int(), name: z.string(), serialNumber: z.string() });
const logCountsSchema = z.object({
  total: z.number().int(),
  open: z.number().int(),
  closed: z.number().int(),
});

const partCountsSchema = z.object({
  total: z.number().int(),
  active: z.number().int(),
  underMaintenance: z.number().int(),
  downtime: z.number().int(),
  underTest: z.number().int(),
  blocking: z.number().int(),
  critical: z.number().int(),
});

const scheduleCountsSchema = z.object({
  total: z.number().int(),
  active: z.number().int(),
  upcoming: z.number().int(),
  due: z.number().int(),
  overdue: z.number().int(),
});

export const overviewResponseSchema = z
  .object({
    range: rangeSchema,
    machines: z.object({
      total: z.number().int(),
      active: z.number().int(),
      underMaintenance: z.number().int(),
      downtime: z.number().int(),
      underTest: z.number().int(),
      inactive: z.number().int(),
    }),
    machineOperational: z.object({
      operating: z.number().int(),
      operatingWithDefects: z.number().int(),
      notOperating: z.number().int(),
    }),
    parts: partCountsSchema,
    maintenance: scheduleCountsSchema,
    logs: logCountsSchema.extend({ currentlyOpen: z.number().int() }),
    totalDowntimeHours: z.number(),
  })
  .meta({ id: 'AnalyticsOverview' });

export const partsAnalyticsResponseSchema = z
  .object({
    range: rangeSchema,
    byStatus: partCountsSchema,
    impact: z.object({
      machinesWithPartIssues: z.number().int(),
      machinesStoppedByParts: z.number().int(),
    }),
    totalPartDowntimeHours: z.number(),
    mostProblematic: z.array(
      z.object({
        machine: machineRefSchema,
        part: z.object({
          id: z.number().int(),
          partCode: z.string(),
          name: z.string(),
          isCritical: z.boolean(),
        }),
        events: z.number().int(),
        downtimeHours: z.number(),
        lastEventAt: z.iso.datetime().nullable(),
      }),
    ),
  })
  .meta({ id: 'AnalyticsParts' });

export const maintenanceAnalyticsResponseSchema = z
  .object({
    range: rangeSchema,
    schedules: scheduleCountsSchema,
    compliance: z.object({
      completed: z.number().int(),
      missed: z.number().int(),
      cancelled: z.number().int(),
      inProgress: z.number().int(),
      scheduled: z.number().int(),
      completedOnTime: z.number().int(),
      onTimeRate: z.number().nullable(),
    }),
    byMachine: z.array(
      z.object({
        machine: machineRefSchema,
        completed: z.number().int(),
        missed: z.number().int(),
        lastCompletedAt: z.iso.datetime().nullable(),
      }),
    ),
  })
  .meta({ id: 'AnalyticsMaintenance' });

export const downtimeResponseSchema = z
  .object({
    range: rangeSchema,
    totalDowntimeHours: z.number(),
    byMachine: z.array(
      z.object({ machine: machineRefSchema, downtimeHours: z.number(), events: z.number().int() }),
    ),
  })
  .meta({ id: 'AnalyticsDowntime' });

export const maintenanceEventsResponseSchema = z
  .object({
    range: rangeSchema,
    totals: logCountsSchema,
    byMachine: z.array(
      z.object({
        machine: machineRefSchema,
        totalEvents: z.number().int(),
        openEvents: z.number().int(),
        closedEvents: z.number().int(),
      }),
    ),
  })
  .meta({ id: 'AnalyticsMaintenanceEvents' });

export const techniciansResponseSchema = z
  .object({
    range: rangeSchema,
    byTechnician: z.array(
      z.object({
        technician: z.object({ id: z.number().int(), fullName: z.string(), position: z.string().nullable() }),
        totalLogs: z.number().int(),
        openLogs: z.number().int(),
        closedLogs: z.number().int(),
        downtimeHours: z.number(),
      }),
    ),
  })
  .meta({ id: 'AnalyticsTechnicians' });

export const faultsResponseSchema = z
  .object({
    range: rangeSchema,
    commonFaults: z.array(
      z.object({
        fault: z.string(),
        occurrences: z.number().int(),
        machinesAffected: z.number().int(),
        lastSeenAt: z.iso.datetime(),
      }),
    ),
    recurringIssues: z.array(
      z.object({
        machine: machineRefSchema,
        fault: z.string(),
        occurrences: z.number().int(),
        firstSeenAt: z.iso.datetime(),
        lastSeenAt: z.iso.datetime(),
      }),
    ),
  })
  .meta({ id: 'AnalyticsFaults' });
