import { diffValues, REDACTED, sanitizeAuditValues } from './audit-sanitizer';

describe('sanitizeAuditValues', () => {
  it('redacts credential-like keys at any depth', () => {
    const result = sanitizeAuditValues({
      email: 'a@example.test',
      password: 'p',
      newPassword: 'n',
      passwordHash: 'h',
      refreshToken: 't',
      nested: { apiSecret: 's', list: [{ accessToken: 'x', ok: 1 }] },
    });
    expect(result).toEqual({
      email: 'a@example.test',
      password: REDACTED,
      newPassword: REDACTED,
      passwordHash: REDACTED,
      refreshToken: REDACTED,
      nested: { apiSecret: REDACTED, list: [{ accessToken: REDACTED, ok: 1 }] },
    });
  });

  it('keeps non-secret flags whose names resemble secrets', () => {
    expect(sanitizeAuditValues({ mustChangePassword: true, passwordExpiresAt: null })).toEqual({
      mustChangePassword: true,
      passwordExpiresAt: null,
    });
  });

  it('serialises dates, drops undefined and truncates long strings', () => {
    const result = sanitizeAuditValues({
      at: new Date('2026-01-01T00:00:00Z'),
      skip: undefined,
      long: 'x'.repeat(3000),
    });
    expect(result?.at).toBe('2026-01-01T00:00:00.000Z');
    expect(result).not.toHaveProperty('skip');
    expect((result?.long as string).length).toBe(2001);
  });

  it('returns null for empty input', () => {
    expect(sanitizeAuditValues(null)).toBeNull();
    expect(sanitizeAuditValues(undefined)).toBeNull();
  });
});

describe('diffValues', () => {
  it('returns only changed keys', () => {
    expect(diffValues({ a: 1, b: 'x', c: null }, { a: 1, b: 'y', c: 'z' })).toEqual({
      oldValues: { b: 'x', c: null },
      newValues: { b: 'y', c: 'z' },
    });
  });

  it('compares dates by value', () => {
    expect(diffValues({ at: new Date(0) }, { at: new Date(0) })).toEqual({ oldValues: {}, newValues: {} });
  });
});
