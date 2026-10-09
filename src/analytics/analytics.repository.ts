import { type DataSource } from 'typeorm';
import { type DateRange } from '../common/utils/date-range';

export interface MachineOperationalCounts {
  readonly operating: number;
  readonly operatingWithDefects: number;
  readonly notOperating: number;
}

export interface PartStatusCounts {
  readonly total: number;
  readonly active: number;
  readonly underMaintenance: number;
  readonly downtime: number;
  readonly underTest: number;
  readonly blocking: number;
  readonly critical: number;
}

export interface PartIssueImpact {
  /** Machines with at least one active part that is not ACTIVE. */
  readonly machinesWithPartIssues: number;
  /** Machines not operating because a critical/blocking part is down. */
  readonly machinesStoppedByParts: number;
}

export interface ProblematicPartRow extends MachineRef {
  readonly partId: number;
  readonly partCode: string;
  readonly partName: string;
  readonly isCritical: boolean;
  readonly events: number;
  readonly downtimeHours: number;
  readonly lastEventAt: Date | null;
}

export interface MaintenanceScheduleCounts {
  readonly total: number;
  readonly active: number;
  readonly upcoming: number;
  readonly due: number;
  readonly overdue: number;
}

export interface MaintenanceComplianceCounts {
  readonly completed: number;
  readonly missed: number;
  readonly cancelled: number;
  readonly inProgress: number;
  readonly scheduled: number;
  readonly completedOnTime: number;
}

export interface MaintenanceByMachineRow extends MachineRef {
  readonly completed: number;
  readonly missed: number;
  readonly lastCompletedAt: Date | null;
}

export interface MachineStatusCounts {
  readonly total: number;
  readonly active: number;
  readonly underMaintenance: number;
  readonly downtime: number;
  readonly underTest: number;
  readonly inactive: number;
}

export interface LogStatusCounts {
  readonly total: number;
  readonly open: number;
  readonly closed: number;
}

export interface MachineRef {
  readonly id: number;
  readonly name: string;
  readonly serialNumber: string;
}

export interface MachineDowntimeRow extends MachineRef {
  readonly downtimeHours: number;
  readonly events: number;
}

export interface MachineEventsRow extends MachineRef {
  readonly totalEvents: number;
  readonly openEvents: number;
  readonly closedEvents: number;
}

export interface TechnicianActivityRow {
  readonly id: number;
  readonly fullName: string;
  readonly position: string | null;
  readonly totalLogs: number;
  readonly openLogs: number;
  readonly closedLogs: number;
  readonly downtimeHours: number;
}

export interface FaultRow {
  readonly fault: string;
  readonly occurrences: number;
  readonly machines: number;
  readonly lastSeenAt: Date;
}

export interface RecurringIssueRow extends MachineRef {
  readonly fault: string;
  readonly occurrences: number;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

/** Normalises free-text faults so "Oil leak", " oil  LEAK " group together. */
const NORMALISED_FAULT = `lower(regexp_replace(btrim(l.fault_description), '\\s+', ' ', 'g'))`;

/** Shared predicate: non-deleted logs whose event started inside [from, to). */
const LOGS_IN_RANGE = `l.deleted_at IS NULL AND l.started_at >= $1 AND l.started_at < $2`;

/**
 * Read-only aggregate queries computed from live data (no denormalised
 * counters). All values are bound parameters. Per-machine event rows are the
 * building blocks for future reliability metrics (MTBF/MTTR).
 */
export class AnalyticsRepository {
  constructor(private readonly dataSource: DataSource) {}

  async machineStatusCounts(): Promise<MachineStatusCounts> {
    const [row] = await this.rows<Record<keyof MachineStatusCounts, number>>(
      `SELECT COUNT(*)::int                                                         AS "total",
              COUNT(*) FILTER (WHERE m.is_active AND m.status = 'ACTIVE')::int            AS "active",
              COUNT(*) FILTER (WHERE m.is_active AND m.status = 'UNDER_MAINTENANCE')::int AS "underMaintenance",
              COUNT(*) FILTER (WHERE m.is_active AND m.status = 'DOWNTIME')::int          AS "downtime",
              COUNT(*) FILTER (WHERE m.is_active AND m.status = 'UNDER_TEST')::int        AS "underTest",
              COUNT(*) FILTER (WHERE NOT m.is_active)::int                                AS "inactive"
         FROM machines m
        WHERE m.deleted_at IS NULL`,
    );
    return row ?? { total: 0, active: 0, underMaintenance: 0, downtime: 0, underTest: 0, inactive: 0 };
  }

  async logStatusCounts(range: DateRange): Promise<LogStatusCounts> {
    const [row] = await this.rows<Record<keyof LogStatusCounts, number>>(
      `SELECT COUNT(*)::int                                          AS "total",
              COUNT(*) FILTER (WHERE l.log_status = 'OPEN')::int     AS "open",
              COUNT(*) FILTER (WHERE l.log_status = 'CLOSED')::int   AS "closed"
         FROM machine_logs l
        WHERE ${LOGS_IN_RANGE}`,
      [range.from, range.to],
    );
    return row ?? { total: 0, open: 0, closed: 0 };
  }

  async openLogsCount(): Promise<number> {
    const [row] = await this.rows<{ count: number }>(
      `SELECT COUNT(*)::int AS "count" FROM machine_logs l WHERE l.deleted_at IS NULL AND l.log_status = 'OPEN'`,
    );
    return row?.count ?? 0;
  }

  async totalDowntimeHours(range: DateRange): Promise<number> {
    const [row] = await this.rows<{ hours: string }>(
      `SELECT COALESCE(SUM(l.downtime_hours), 0)::numeric(14,2) AS "hours" FROM machine_logs l WHERE ${LOGS_IN_RANGE}`,
      [range.from, range.to],
    );
    return Number(row?.hours ?? 0);
  }

  async downtimeByMachine(range: DateRange, limit: number): Promise<MachineDowntimeRow[]> {
    const rows = await this.rows<MachineRef & { downtimeHours: string; events: number }>(
      `SELECT m.id AS "id", m.name AS "name", m.serial_number AS "serialNumber",
              SUM(l.downtime_hours)::numeric(14,2) AS "downtimeHours",
              COUNT(*)::int AS "events"
         FROM machine_logs l
         JOIN machines m ON m.id = l.machine_id
        WHERE ${LOGS_IN_RANGE}
        GROUP BY m.id
       HAVING SUM(l.downtime_hours) > 0
        ORDER BY SUM(l.downtime_hours) DESC, m.id
        LIMIT $3`,
      [range.from, range.to, limit],
    );
    return rows.map((row) => ({ ...row, downtimeHours: Number(row.downtimeHours) }));
  }

  eventsByMachine(range: DateRange, limit: number): Promise<MachineEventsRow[]> {
    return this.rows<MachineEventsRow>(
      `SELECT m.id AS "id", m.name AS "name", m.serial_number AS "serialNumber",
              COUNT(*)::int                                          AS "totalEvents",
              COUNT(*) FILTER (WHERE l.log_status = 'OPEN')::int     AS "openEvents",
              COUNT(*) FILTER (WHERE l.log_status = 'CLOSED')::int   AS "closedEvents"
         FROM machine_logs l
         JOIN machines m ON m.id = l.machine_id
        WHERE ${LOGS_IN_RANGE}
        GROUP BY m.id
        ORDER BY COUNT(*) DESC, m.id
        LIMIT $3`,
      [range.from, range.to, limit],
    );
  }

  async logsByTechnician(range: DateRange, limit: number): Promise<TechnicianActivityRow[]> {
    const rows = await this.rows<Omit<TechnicianActivityRow, 'downtimeHours'> & { downtimeHours: string }>(
      `SELECT u.id AS "id", u.full_name AS "fullName", u.position AS "position",
              COUNT(*)::int                                          AS "totalLogs",
              COUNT(*) FILTER (WHERE l.log_status = 'OPEN')::int     AS "openLogs",
              COUNT(*) FILTER (WHERE l.log_status = 'CLOSED')::int   AS "closedLogs",
              COALESCE(SUM(l.downtime_hours), 0)::numeric(14,2)      AS "downtimeHours"
         FROM machine_logs l
         JOIN users u ON u.id = l.user_id
        WHERE ${LOGS_IN_RANGE}
        GROUP BY u.id
        ORDER BY COUNT(*) DESC, u.id
        LIMIT $3`,
      [range.from, range.to, limit],
    );
    return rows.map((row) => ({ ...row, downtimeHours: Number(row.downtimeHours) }));
  }

  commonFaults(range: DateRange, limit: number): Promise<FaultRow[]> {
    return this.rows<FaultRow>(
      `SELECT ${NORMALISED_FAULT} AS "fault",
              COUNT(*)::int AS "occurrences",
              COUNT(DISTINCT l.machine_id)::int AS "machines",
              MAX(l.started_at) AS "lastSeenAt"
         FROM machine_logs l
        WHERE ${LOGS_IN_RANGE}
        GROUP BY 1
        ORDER BY COUNT(*) DESC, 1
        LIMIT $3`,
      [range.from, range.to, limit],
    );
  }

  recurringIssues(range: DateRange, minOccurrences: number, limit: number): Promise<RecurringIssueRow[]> {
    return this.rows<RecurringIssueRow>(
      `SELECT m.id AS "id", m.name AS "name", m.serial_number AS "serialNumber",
              ${NORMALISED_FAULT} AS "fault",
              COUNT(*)::int AS "occurrences",
              MIN(l.started_at) AS "firstSeenAt",
              MAX(l.started_at) AS "lastSeenAt"
         FROM machine_logs l
         JOIN machines m ON m.id = l.machine_id
        WHERE ${LOGS_IN_RANGE}
        GROUP BY m.id, 4
       HAVING COUNT(*) >= $3
        ORDER BY COUNT(*) DESC, MAX(l.started_at) DESC
        LIMIT $4`,
      [range.from, range.to, minOccurrences, limit],
    );
  }

  // ---------------------------------------------------- parts & derived status

  async machineOperationalCounts(): Promise<MachineOperationalCounts> {
    const [row] = await this.rows<Record<keyof MachineOperationalCounts, number>>(
      `SELECT COUNT(*) FILTER (WHERE m.operational_status = 'OPERATING')::int              AS "operating",
              COUNT(*) FILTER (WHERE m.operational_status = 'OPERATING_WITH_DEFECTS')::int AS "operatingWithDefects",
              COUNT(*) FILTER (WHERE m.operational_status = 'NOT_OPERATING')::int          AS "notOperating"
         FROM machines m
        WHERE m.deleted_at IS NULL AND m.is_active`,
    );
    return row ?? { operating: 0, operatingWithDefects: 0, notOperating: 0 };
  }

  async partStatusCounts(): Promise<PartStatusCounts> {
    const [row] = await this.rows<Record<keyof PartStatusCounts, number>>(
      `SELECT COUNT(*)::int                                                          AS "total",
              COUNT(*) FILTER (WHERE p.status = 'ACTIVE')::int                       AS "active",
              COUNT(*) FILTER (WHERE p.status = 'UNDER_MAINTENANCE')::int            AS "underMaintenance",
              COUNT(*) FILTER (WHERE p.status = 'DOWNTIME')::int                     AS "downtime",
              COUNT(*) FILTER (WHERE p.status = 'UNDER_TEST')::int                   AS "underTest",
              COUNT(*) FILTER (WHERE p.status <> 'ACTIVE'
                                 AND p.operational_impact = 'BLOCKING')::int         AS "blocking",
              COUNT(*) FILTER (WHERE p.is_critical)::int                             AS "critical"
         FROM machine_parts p
         JOIN machines m ON m.id = p.machine_id AND m.deleted_at IS NULL
        WHERE p.deleted_at IS NULL AND p.is_active`,
    );
    return (
      row ?? { total: 0, active: 0, underMaintenance: 0, downtime: 0, underTest: 0, blocking: 0, critical: 0 }
    );
  }

  async partIssueImpact(): Promise<PartIssueImpact> {
    const [row] = await this.rows<Record<keyof PartIssueImpact, number>>(
      `SELECT COUNT(DISTINCT p.machine_id) FILTER (WHERE p.status <> 'ACTIVE')::int AS "machinesWithPartIssues",
              COUNT(DISTINCT p.machine_id) FILTER (
                WHERE p.status <> 'ACTIVE' AND p.operational_impact = 'BLOCKING'
              )::int AS "machinesStoppedByParts"
         FROM machine_parts p
         JOIN machines m ON m.id = p.machine_id AND m.deleted_at IS NULL AND m.is_active
        WHERE p.deleted_at IS NULL AND p.is_active`,
    );
    return row ?? { machinesWithPartIssues: 0, machinesStoppedByParts: 0 };
  }

  /** Parts with the most logged events in the range ("most problematic"). */
  async problematicParts(range: DateRange, limit: number): Promise<ProblematicPartRow[]> {
    const rows = await this.rows<Omit<ProblematicPartRow, 'downtimeHours'> & { downtimeHours: string }>(
      `SELECT m.id AS "id", m.name AS "name", m.serial_number AS "serialNumber",
              p.id AS "partId", p.part_code AS "partCode", p.name AS "partName",
              p.is_critical AS "isCritical",
              COUNT(*)::int AS "events",
              COALESCE(SUM(l.downtime_hours), 0)::numeric(14,2) AS "downtimeHours",
              MAX(l.started_at) AS "lastEventAt"
         FROM machine_logs l
         JOIN machine_parts p ON p.id = l.machine_part_id
         JOIN machines m ON m.id = l.machine_id
        WHERE l.scope = 'PART' AND ${LOGS_IN_RANGE}
        GROUP BY m.id, p.id
        ORDER BY COUNT(*) DESC, SUM(l.downtime_hours) DESC NULLS LAST, p.id
        LIMIT $3`,
      [range.from, range.to, limit],
    );
    return rows.map((row) => ({ ...row, downtimeHours: Number(row.downtimeHours) }));
  }

  async partDowntimeHours(range: DateRange): Promise<number> {
    const [row] = await this.rows<{ hours: string }>(
      `SELECT COALESCE(SUM(l.downtime_hours), 0)::numeric(14,2) AS "hours"
         FROM machine_logs l
        WHERE l.scope = 'PART' AND ${LOGS_IN_RANGE}`,
      [range.from, range.to],
    );
    return Number(row?.hours ?? 0);
  }

  // ------------------------------------------------------ recurring maintenance

  async maintenanceScheduleCounts(now: Date): Promise<MaintenanceScheduleCounts> {
    const [row] = await this.rows<Record<keyof MaintenanceScheduleCounts, number>>(
      `SELECT COUNT(*)::int                                   AS "total",
              COUNT(*) FILTER (WHERE s.is_active)::int        AS "active",
              COUNT(*) FILTER (
                WHERE s.is_active
                  AND date_trunc('day', s.next_maintenance_at) > date_trunc('day', $1::timestamptz)
              )::int AS "upcoming",
              COUNT(*) FILTER (
                WHERE s.is_active
                  AND date_trunc('day', s.next_maintenance_at) = date_trunc('day', $1::timestamptz)
              )::int AS "due",
              COUNT(*) FILTER (
                WHERE s.is_active
                  AND date_trunc('day', s.next_maintenance_at) < date_trunc('day', $1::timestamptz)
              )::int AS "overdue"
         FROM maintenance_schedules s
         JOIN machines m ON m.id = s.machine_id AND m.deleted_at IS NULL`,
      [now],
    );
    return row ?? { total: 0, active: 0, upcoming: 0, due: 0, overdue: 0 };
  }

  /** Event outcomes in the range; "on time" means completed on or before the scheduled day. */
  async maintenanceCompliance(range: DateRange): Promise<MaintenanceComplianceCounts> {
    const [row] = await this.rows<Record<keyof MaintenanceComplianceCounts, number>>(
      `SELECT COUNT(*) FILTER (WHERE e.status = 'COMPLETED')::int   AS "completed",
              COUNT(*) FILTER (WHERE e.status = 'MISSED')::int      AS "missed",
              COUNT(*) FILTER (WHERE e.status = 'CANCELLED')::int   AS "cancelled",
              COUNT(*) FILTER (WHERE e.status = 'IN_PROGRESS')::int AS "inProgress",
              COUNT(*) FILTER (WHERE e.status = 'SCHEDULED')::int   AS "scheduled",
              COUNT(*) FILTER (
                WHERE e.status = 'COMPLETED'
                  AND date_trunc('day', e.completed_at) <= date_trunc('day', e.scheduled_for)
              )::int AS "completedOnTime"
         FROM maintenance_events e
         JOIN machines m ON m.id = e.machine_id AND m.deleted_at IS NULL
        WHERE e.scheduled_for >= $1 AND e.scheduled_for < $2`,
      [range.from, range.to],
    );
    return row ?? { completed: 0, missed: 0, cancelled: 0, inProgress: 0, scheduled: 0, completedOnTime: 0 };
  }

  maintenanceByMachine(range: DateRange, limit: number): Promise<MaintenanceByMachineRow[]> {
    return this.rows<MaintenanceByMachineRow>(
      `SELECT m.id AS "id", m.name AS "name", m.serial_number AS "serialNumber",
              COUNT(*) FILTER (WHERE e.status = 'COMPLETED')::int AS "completed",
              COUNT(*) FILTER (WHERE e.status = 'MISSED')::int    AS "missed",
              MAX(e.completed_at) AS "lastCompletedAt"
         FROM maintenance_events e
         JOIN machines m ON m.id = e.machine_id
        WHERE m.deleted_at IS NULL AND e.scheduled_for >= $1 AND e.scheduled_for < $2
        GROUP BY m.id
        ORDER BY COUNT(*) FILTER (WHERE e.status = 'MISSED') DESC, COUNT(*) DESC, m.id
        LIMIT $3`,
      [range.from, range.to, limit],
    );
  }

  private async rows<T>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    const result: unknown = await this.dataSource.query(sql, parameters);
    return Array.isArray(result) ? (result as T[]) : [];
  }
}
