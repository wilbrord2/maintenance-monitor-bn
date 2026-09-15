import { constantTimeEqualHex, generateSecureToken, generateTemporaryPassword, sha256Hex } from './crypto';

describe('crypto utilities', () => {
  it('generates temporary passwords that contain every character class', () => {
    for (let i = 0; i < 200; i += 1) {
      const password = generateTemporaryPassword();
      expect(password).toHaveLength(16);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[!@#$%*\-_+=?]/);
      expect(password).not.toMatch(/[O0Il1]/);
    }
  });

  it('refuses short temporary passwords', () => {
    expect(() => generateTemporaryPassword(8)).toThrow(RangeError);
  });

  it('generates unique URL-safe tokens', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateSecureToken()));
    expect(tokens.size).toBe(100);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes deterministically and compares in constant time', () => {
    const digest = sha256Hex('value');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(constantTimeEqualHex(digest, sha256Hex('value'))).toBe(true);
    expect(constantTimeEqualHex(digest, sha256Hex('other'))).toBe(false);
    expect(constantTimeEqualHex(digest, 'abcd')).toBe(false);
    expect(constantTimeEqualHex('', '')).toBe(false);
  });
});
