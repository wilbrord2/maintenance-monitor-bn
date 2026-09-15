import { z } from 'zod';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../pagination/pagination';

const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const DELETE = 0x7f;

/** True when the string contains ASCII control characters (optionally permitting line breaks and tabs). */
export function hasControlCharacters(value: string, allowMultiline: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === DELETE) return true;
    if (code >= 0x20) continue;
    if (allowMultiline && (code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN)) continue;
    return true;
  }
  return false;
}

const boundedString = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, min === 1 ? 'must not be empty' : `must be at least ${min} characters`)
    .max(max, `must be at most ${max} characters`);

/** A trimmed, single-line string. */
export const text = (min: number, max: number) =>
  boundedString(min, max).refine(
    (value) => !hasControlCharacters(value, false),
    'must not contain control characters',
  );

/** A trimmed string that may span several lines (descriptions, remedies). */
export const multilineText = (min: number, max: number) =>
  boundedString(min, max).refine(
    (value) => !hasControlCharacters(value, true),
    'must not contain control characters',
  );

export const emailAddress = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'must be at most 254 characters')
  .regex(z.regexes.email, 'must be a valid email address')
  .meta({ format: 'email', example: 'jane.doe@example.com' });

/** Digits with an optional leading "+", e.g. 0780000000 or +250780000000. */
export const phoneNumber = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{9,15}$/, 'must be 9–15 digits with an optional leading +')
  .meta({ example: '0780000000' });

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** New-password policy. Existing passwords are only length-bounded (see `passwordInput`). */
export const strongPassword = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .regex(/[a-z]/, 'must contain a lowercase letter')
  .regex(/[A-Z]/, 'must contain an uppercase letter')
  .regex(/[0-9]/, 'must contain a digit')
  .meta({ format: 'password' });

/** A password supplied for verification; bounded to keep hashing cost predictable. */
export const passwordInput = z
  .string()
  .min(1, 'is required')
  .max(PASSWORD_MAX_LENGTH, `must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .meta({ format: 'password' });

const ID_MESSAGE = 'must be a positive integer';

export const positiveId = z.coerce
  .number({ error: ID_MESSAGE })
  .int(ID_MESSAGE)
  .positive(ID_MESSAGE)
  .max(2_147_483_647, 'is out of range');

export const idParams = z.object({ id: positiveId.meta({ description: 'Resource identifier', example: 1 }) });

/** ISO-8601 date-time with timezone offset, parsed to a Date. */
export const isoDateTime = z.iso
  .datetime({ offset: true, message: 'must be an ISO-8601 date-time with timezone' })
  .transform((value) => new Date(value));

/** Calendar date (YYYY-MM-DD). Kept as a string; interpreted in UTC. */
export const isoDate = z.iso.date({ message: 'must be a date in YYYY-MM-DD format' });

export const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');

export const sortOrderSchema = z.enum(['asc', 'desc']);
export const sortOrder = sortOrderSchema.default('desc');

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1).meta({ description: 'Page number (1-based)' }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT)
    .meta({ description: `Page size (max ${MAX_PAGE_LIMIT})` }),
});

export const searchQuery = text(1, 100).optional().meta({ description: 'Case-insensitive search term' });

export const sortingQuery = <const T extends readonly [string, ...string[]]>(
  fields: T,
  fallback: T[number],
  defaultOrder: 'asc' | 'desc' = 'desc',
) =>
  z.object({
    sortBy: z.enum(fields).default(fallback),
    sortOrder: sortOrderSchema.default(defaultOrder),
  });
