const UNIT_SECONDS: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

const DURATION_PATTERN = /^(\d+)([smhd])$/;

/**
 * Parses a compact duration string ("900s", "15m", "12h", "7d") into seconds.
 * Returns null when the input is not a valid positive duration.
 */
export function parseDurationToSeconds(value: string): number | null {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === undefined ? undefined : UNIT_SECONDS[unit];
  if (!Number.isSafeInteger(amount) || amount <= 0 || multiplier === undefined) return null;
  return amount * multiplier;
}
