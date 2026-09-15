import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** SHA-256 hex digest. Suitable for high-entropy tokens (not for passwords). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/** URL-safe random token with `bytes` bytes of entropy. */
export function generateSecureToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const LOWER = 'abcdefghjkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%*-_+=?';
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

function pick(alphabet: string): string {
  return alphabet.charAt(randomInt(alphabet.length));
}

/**
 * Cryptographically random temporary password containing every character
 * class (ambiguous characters such as O/0 and l/1 are excluded).
 */
export function generateTemporaryPassword(length = 16): string {
  if (length < 12) throw new RangeError('Temporary passwords must be at least 12 characters');
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < length) chars.push(pick(ALL));
  // Fisher–Yates shuffle so the guaranteed classes are not in fixed positions.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const current = chars[i];
    const other = chars[j];
    if (current === undefined || other === undefined) continue;
    chars[i] = other;
    chars[j] = current;
  }
  return chars.join('');
}
