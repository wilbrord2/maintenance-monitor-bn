import { parseDurationToSeconds } from './duration';

describe('parseDurationToSeconds', () => {
  it.each([
    ['45s', 45],
    ['15m', 900],
    ['12h', 43_200],
    ['7d', 604_800],
  ])('parses %s', (input, expected) => {
    expect(parseDurationToSeconds(input)).toBe(expected);
  });

  it.each(['', '0m', '-5m', '15', '1w', '1.5h', 'abc'])('rejects %p', (input) => {
    expect(parseDurationToSeconds(input)).toBeNull();
  });
});
