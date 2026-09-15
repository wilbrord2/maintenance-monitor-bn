export interface DowntimeInput {
  readonly explicitHours: number | undefined;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

const MS_PER_HOUR = 3_600_000;

export function roundHours(hours: number): number {
  return Math.round(hours * 100) / 100;
}

/**
 * Resolves downtime hours for a log:
 * 1. an explicit value always wins — technicians send one (e.g. 0) for work
 *    that did not stop the machine, or when only part of the event was downtime;
 * 2. otherwise, once the event has an end time, downtime is endedAt − startedAt;
 * 3. otherwise 0 (the event is still ongoing).
 *
 * The rule is deliberately simple and predictable. It is isolated here so a
 * future version can derive downtime from status history instead.
 */
export class DowntimeCalculator {
  resolve(input: DowntimeInput): number {
    if (input.explicitHours !== undefined) return roundHours(input.explicitHours);
    if (!input.endedAt) return 0;
    return roundHours(Math.max(0, input.endedAt.getTime() - input.startedAt.getTime()) / MS_PER_HOUR);
  }
}
