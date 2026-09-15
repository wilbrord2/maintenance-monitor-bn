import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { calendarRange, type DateRange, daysBetween, lastDays } from '../common/utils/date-range';

export const DEFAULT_ANALYTICS_DAYS = 30;
export const MAX_ANALYTICS_DAYS = 366;

export interface TimeRangeQuery {
  readonly days?: number | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export interface ResolvedTimeRange extends DateRange {
  /** Number of days covered by the range. */
  readonly days: number;
  readonly kind: 'rolling' | 'calendar';
}

/** Rejects impossible dates such as 2026-02-30, which Date would silently roll over. */
function isRealCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function invalid(field: string, message: string): AppError {
  return new AppError(400, ErrorCode.INVALID_TIME_RANGE, `Invalid time range: ${message}`, [
    { field, message },
  ]);
}

/**
 * Resolves analytics query parameters to a half-open UTC interval:
 * - nothing          → the last 30 days up to now
 * - `days=N`         → the last N days up to now (1–366)
 * - `from` and `to`  → whole calendar days, both inclusive (at most 366 days)
 */
export function resolveTimeRange(query: TimeRangeQuery, now: Date): ResolvedTimeRange {
  const hasCalendarBound = query.from !== undefined || query.to !== undefined;

  if (query.days !== undefined && hasCalendarBound) {
    throw invalid('days', 'use either days or from/to, not both');
  }
  if (!hasCalendarBound) {
    const days = query.days ?? DEFAULT_ANALYTICS_DAYS;
    if (!Number.isInteger(days) || days < 1 || days > MAX_ANALYTICS_DAYS) {
      throw invalid('days', `must be an integer between 1 and ${MAX_ANALYTICS_DAYS}`);
    }
    return { ...lastDays(days, now), days, kind: 'rolling' };
  }
  if (query.from === undefined) throw invalid('from', 'is required when to is provided');
  if (query.to === undefined) throw invalid('to', 'is required when from is provided');

  if (!isRealCalendarDate(query.from)) throw invalid('from', 'must be a valid calendar date');
  if (!isRealCalendarDate(query.to)) throw invalid('to', 'must be a valid calendar date');
  const range = calendarRange(query.from, query.to);
  if (range.from >= range.to) throw invalid('to', 'must be on or after from');
  if (range.from > now) throw invalid('from', 'cannot be in the future');

  const days = daysBetween(range);
  if (days > MAX_ANALYTICS_DAYS) throw invalid('to', `range cannot exceed ${MAX_ANALYTICS_DAYS} days`);
  return { ...range, days, kind: 'calendar' };
}
