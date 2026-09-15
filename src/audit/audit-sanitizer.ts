import { type AuditValues } from './audit-log.entity';

const SENSITIVE_KEY = /(password|passwd|secret|token|hash|credentials?|authorization|cookie|otp)$/i;
/** Non-secret metadata whose names would otherwise match the sensitive pattern. */
const SAFE_KEYS = new Set(['mustChangePassword', 'tokenType']);
const MAX_DEPTH = 5;

function isSensitiveKey(key: string): boolean {
  return !SAFE_KEYS.has(key) && SENSITIVE_KEY.test(key);
}
const MAX_STRING_LENGTH = 2000;
export const REDACTED = '[REDACTED]';

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string')
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (nested === undefined) continue;
      result[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(nested, depth + 1);
    }
    return result;
  }
  // bigint, symbol and functions are not meaningful audit data.
  return typeof value === 'bigint' ? value.toString() : null;
}

function normalizeForComparison(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Produces a JSON-safe copy of audit values with any credential-like fields
 * redacted. Applied to every audit write as a defence in depth.
 */
export function sanitizeAuditValues(values: AuditValues | null | undefined): AuditValues | null {
  if (!values) return null;
  return sanitizeValue(values, 0) as AuditValues;
}

/** Returns only the keys whose values differ between two snapshots. */
export function diffValues(
  before: AuditValues,
  after: AuditValues,
): { oldValues: AuditValues; newValues: AuditValues } {
  const oldValues: AuditValues = {};
  const newValues: AuditValues = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const left = normalizeForComparison(before[key]);
    const right = normalizeForComparison(after[key]);
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      oldValues[key] = left ?? null;
      newValues[key] = right ?? null;
    }
  }
  return { oldValues, newValues };
}
