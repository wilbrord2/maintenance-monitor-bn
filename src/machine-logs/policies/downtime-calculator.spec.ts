import { DowntimeCalculator, roundHours } from './downtime-calculator';

const start = new Date('2026-09-01T08:00:00Z');
const plus = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

describe('DowntimeCalculator', () => {
  const calculator = new DowntimeCalculator();
  const input = { explicitHours: undefined, startedAt: start, endedAt: plus(150) };

  it('computes the hours between start and end once the event has ended', () => {
    expect(calculator.resolve(input)).toBe(2.5);
  });

  it('prefers an explicit value (including 0), rounded to two decimals', () => {
    expect(calculator.resolve({ ...input, explicitHours: 1.23456 })).toBe(1.23);
    expect(calculator.resolve({ ...input, explicitHours: 0 })).toBe(0);
  });

  it('returns 0 for ongoing events', () => {
    expect(calculator.resolve({ ...input, endedAt: null })).toBe(0);
  });

  it('never returns a negative duration', () => {
    expect(calculator.resolve({ ...input, endedAt: plus(-30) })).toBe(0);
  });

  it('rounds to hundredths', () => {
    expect(roundHours(1 / 3)).toBe(0.33);
    expect(calculator.resolve({ ...input, endedAt: plus(20) })).toBe(0.33);
  });
});
