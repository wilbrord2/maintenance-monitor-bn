import { type DataSource } from 'typeorm';
import { type DateRange } from '../common/utils/date-range';

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

  private async rows<T>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    const result: unknown = await this.dataSource.query(sql, parameters);
    return Array.isArray(result) ? (result as T[]) : [];
  }
}
