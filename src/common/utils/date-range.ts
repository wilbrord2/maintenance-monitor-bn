const MS_PER_DAY = 86_400_000;

/** Half-open interval [from, to). All calendar dates are interpreted in UTC. */
export interface DateRange {
  readonly from: Date;
  readonly to: Date;
}

/** Start of the given YYYY-MM-DD day in UTC. */
export function startOfUtcDay(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

/** Exclusive upper bound for an inclusive YYYY-MM-DD end date. */
export function endOfUtcDayExclusive(isoDate: string): Date {
  return new Date(startOfUtcDay(isoDate).getTime() + MS_PER_DAY);
}

export function daysBetween(range: DateRange): number {
  return Math.round((range.to.getTime() - range.from.getTime()) / MS_PER_DAY);
}

export function lastDays(days: number, now: Date): DateRange {
  return { from: new Date(now.getTime() - days * MS_PER_DAY), to: now };
}

export function calendarRange(fromDate: string, toDate: string): DateRange {
  return { from: startOfUtcDay(fromDate), to: endOfUtcDayExclusive(toDate) };
}
