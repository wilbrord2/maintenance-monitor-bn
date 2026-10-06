import { type Clock } from '../common/utils/clock';
import {
  type AnalyticsRepository,
  type MaintenanceByMachineRow,
  type ProblematicPartRow,
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
  /** Machine workflow statuses (machine logs). */
  readonly machines: MachineStatusCounts;
  /** Derived operational statuses (parts + workflow). */
  readonly machineOperational: Awaited<ReturnType<AnalyticsRepository['machineOperationalCounts']>>;
  readonly parts: Awaited<ReturnType<AnalyticsRepository['partStatusCounts']>>;
  readonly maintenance: Awaited<ReturnType<AnalyticsRepository['maintenanceScheduleCounts']>>;
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
    const [machines, machineOperational, parts, maintenance, logs, currentlyOpen, totalDowntimeHours] =
      await Promise.all([
        this.repository.machineStatusCounts(),
        this.repository.machineOperationalCounts(),
        this.repository.partStatusCounts(),
        this.repository.maintenanceScheduleCounts(this.clock.now()),
        this.repository.logStatusCounts(range),
        this.repository.openLogsCount(),
        this.repository.totalDowntimeHours(range),
      ]);
    return {
      range: toSummary(range),
      machines,
      machineOperational,
      parts,
      maintenance,
      logs: { ...logs, currentlyOpen },
      totalDowntimeHours,
    };
  }

  /** Part conditions, their impact on the fleet and the most problematic parts. */
  async parts(query: TimeRangeQuery & { limit: number }) {
    const range = this.range(query);
    const [byStatus, impact, mostProblematic, totalPartDowntimeHours] = await Promise.all([
      this.repository.partStatusCounts(),
      this.repository.partIssueImpact(),
      this.repository.problematicParts(range, query.limit),
      this.repository.partDowntimeHours(range),
    ]);
    return {
      range: toSummary(range),
      byStatus,
      impact,
      totalPartDowntimeHours,
      mostProblematic: mostProblematic.map((row: ProblematicPartRow) => ({
        machine: machineRef(row),
        part: {
          id: row.partId,
          partCode: row.partCode,
          name: row.partName,
          isCritical: row.isCritical,
        },
        events: row.events,
        downtimeHours: row.downtimeHours,
        lastEventAt: row.lastEventAt ? new Date(row.lastEventAt).toISOString() : null,
      })),
    };
  }

  /** Recurring-maintenance compliance: schedules by state, outcomes and per-machine history. */
  async maintenance(query: TimeRangeQuery & { limit: number }) {
    const range = this.range(query);
    const [schedules, compliance, byMachine] = await Promise.all([
      this.repository.maintenanceScheduleCounts(this.clock.now()),
      this.repository.maintenanceCompliance(range),
      this.repository.maintenanceByMachine(range, query.limit),
    ]);
    const finished = compliance.completed + compliance.missed;
    return {
      range: toSummary(range),
      schedules,
      compliance: {
        ...compliance,
        /** Share of finished maintenances completed on or before the scheduled day. */
        onTimeRate: finished === 0 ? null : Math.round((compliance.completedOnTime / finished) * 100) / 100,
      },
      byMachine: byMachine.map((row: MaintenanceByMachineRow) => ({
        machine: machineRef(row),
        completed: row.completed,
        missed: row.missed,
        lastCompletedAt: row.lastCompletedAt ? new Date(row.lastCompletedAt).toISOString() : null,
      })),
    };
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
