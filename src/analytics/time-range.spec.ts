import { type AppError } from '../common/errors/app-error';
import { resolveTimeRange, type TimeRangeQuery } from './time-range';

const NOW = new Date('2026-09-11T15:30:00.000Z');
const DAY = 86_400_000;

function errorOf(query: TimeRangeQuery): AppError | null {
  try {
    resolveTimeRange(query, NOW);
    return null;
  } catch (error) {
    return error as AppError;
  }
}

describe('resolveTimeRange', () => {
  it('defaults to the last 30 days', () => {
    const range = resolveTimeRange({}, NOW);
    expect(range).toMatchObject({ days: 30, kind: 'rolling', to: NOW });
    expect(NOW.getTime() - range.from.getTime()).toBe(30 * DAY);
  });

  it.each([7, 30, 90])('supports days=%i', (days) => {
    const range = resolveTimeRange({ days }, NOW);
    expect(range.days).toBe(days);
    expect(NOW.getTime() - range.from.getTime()).toBe(days * DAY);
  });

  it('supports inclusive calendar ranges in UTC', () => {
    const range = resolveTimeRange({ from: '2026-08-01', to: '2026-08-31' }, NOW);
    expect(range.from.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(range).toMatchObject({ days: 31, kind: 'calendar' });
  });

  it('accepts a single-day range', () => {
    expect(resolveTimeRange({ from: '2026-09-11', to: '2026-09-11' }, NOW).days).toBe(1);
  });

  it.each<[TimeRangeQuery, string]>([
    [{ days: 7, from: '2026-01-01', to: '2026-01-02' }, 'days'],
    [{ from: '2026-01-01' }, 'to'],
    [{ to: '2026-01-01' }, 'from'],
    [{ from: '2026-02-01', to: '2026-01-01' }, 'to'],
    [{ from: '2027-01-01', to: '2027-01-02' }, 'from'],
    [{ from: '2024-01-01', to: '2026-01-01' }, 'to'],
    [{ days: 0 }, 'days'],
    [{ days: 400 }, 'days'],
    [{ from: '2026-02-30', to: '2026-03-01' }, 'from'],
  ])('rejects %j (field %s)', (query, field) => {
    expect(errorOf(query)).toMatchObject({
      statusCode: 400,
      code: 'INVALID_TIME_RANGE',
      details: [expect.objectContaining({ field })],
    });
  });
});
