import { type Clock } from '../common/utils/clock';
import {
  type AnalyticsRepository,
  type FaultRow,
  type LogStatusCounts,
  type MachineDowntimeRow,
  type MachineEventsRow,
  type MachineRef,
  type MachineStatusCounts,
  type RecurringIssueRow,
  type TechnicianActivityRow,
} from './analytics.repository';
import { resolveTimeRange, type ResolvedTimeRange, type TimeRangeQuery } from './time-range';

export interface RangeSummary {
  readonly from: string;
  readonly to: string;
  readonly days: number;
}

export interface AnalyticsOverview {
  readonly range: RangeSummary;
  readonly machines: MachineStatusCounts;
  readonly logs: LogStatusCounts & { readonly currentlyOpen: number };
  readonly totalDowntimeHours: number;
}

const toSummary = (range: ResolvedTimeRange): RangeSummary => ({
  from: range.from.toISOString(),
  to: range.to.toISOString(),
  days: range.days,
});

const machineRef = (row: MachineRef): MachineRef => ({
  id: row.id,
  name: row.name,
  serialNumber: row.serialNumber,
});

/**
 * Fleet analytics. Each report resolves its own time range (default: last 30
 * days on the log's startedAt). New reliability reports such as MTBF and MTTR
 * belong here, built on the per-machine event queries in AnalyticsRepository.
 */
export class AnalyticsService {
  constructor(
    private readonly repository: AnalyticsRepository,
    private readonly clock: Clock,
  ) {}

  async overview(query: TimeRangeQuery): Promise<AnalyticsOverview> {
    const range = this.range(query);
    const [machines, logs, currentlyOpen, totalDowntimeHours] = await Promise.all([
      this.repository.machineStatusCounts(),
      this.repository.logStatusCounts(range),
      this.repository.openLogsCount(),
      this.repository.totalDowntimeHours(range),
    ]);
    return { range: toSummary(range), machines, logs: { ...logs, currentlyOpen }, totalDowntimeHours };
  }

  async downtime(query: TimeRangeQuery & { limit: number }) {
    const range = this.range(query);
    const [totalDowntimeHours, byMachine] = await Promise.all([
      this.repository.totalDowntimeHours(range),
      this.repository.downtimeByMachine(range, query.limit),
    ]);
    return {
      range: toSummary(range),
      totalDowntimeHours,
      byMachine: byMachine.map((row: MachineDowntimeRow) => ({
        machine: machineRef(row),
        downtimeHours: row.downtimeHours,
        events: row.events,
      })),
    };
  }

  async maintenanceEvents(query: TimeRangeQuery & { limit: number }) {
    const range = this.range(query);
    const [totals, byMachine] = await Promise.all([
      this.repository.logStatusCounts(range),
      this.repository.eventsByMachine(range, query.limit),
    ]);
    return {
      range: toSummary(range),
      totals,
      byMachine: byMachine.map((row: MachineEventsRow) => ({
        machine: machineRef(row),
        totalEvents: row.totalEvents,
        openEvents: row.openEvents,
        closedEvents: row.closedEvents,
      })),
    };
  }

  async technicians(query: TimeRangeQuery & { limit: number }) {
    const range = this.range(query);
    const rows = await this.repository.logsByTechnician(range, query.limit);
    return {
      range: toSummary(range),
      byTechnician: rows.map((row: TechnicianActivityRow) => ({
        technician: { id: row.id, fullName: row.fullName, position: row.position },
        totalLogs: row.totalLogs,
        openLogs: row.openLogs,
        closedLogs: row.closedLogs,
        downtimeHours: row.downtimeHours,
      })),
    };
  }

  async faults(query: TimeRangeQuery & { limit: number; minOccurrences: number }) {
    const range = this.range(query);
    const [common, recurring] = await Promise.all([
      this.repository.commonFaults(range, query.limit),
      this.repository.recurringIssues(range, query.minOccurrences, query.limit),
    ]);
    return {
      range: toSummary(range),
      commonFaults: common.map((row: FaultRow) => ({
        fault: row.fault,
        occurrences: row.occurrences,
        machinesAffected: row.machines,
        lastSeenAt: new Date(row.lastSeenAt).toISOString(),
      })),
      recurringIssues: recurring.map((row: RecurringIssueRow) => ({
        machine: machineRef(row),
        fault: row.fault,
        occurrences: row.occurrences,
        firstSeenAt: new Date(row.firstSeenAt).toISOString(),
        lastSeenAt: new Date(row.lastSeenAt).toISOString(),
      })),
    };
  }

  private range(query: TimeRangeQuery): ResolvedTimeRange {
    return resolveTimeRange(query, this.clock.now());
  }
}
