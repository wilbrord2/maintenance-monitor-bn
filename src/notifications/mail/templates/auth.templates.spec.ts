import { passwordResetEmail, technicianOnboardingEmail } from './auth.templates';

describe('email templates', () => {
  it('escapes user-controlled values in HTML', () => {
    const email = technicianOnboardingEmail({
      fullName: '<script>alert(1)</script>',
      email: 'x@example.test',
      temporaryPassword: 'Ab<3&"\'Zz12345!',
      expiresAt: new Date('2026-09-14T10:00:00Z'),
      loginUrl: 'https://app.example.test/login?a=1&b=2',
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).toContain('Ab&lt;3&amp;&quot;&#39;Zz12345!');
    expect(email.text).toContain('Temporary password: Ab<3&"\'Zz12345!');
    expect(email.text).toContain('2026-09-14 10:00 UTC');
  });

  it('includes the single-use reset link and expiry', () => {
    const email = passwordResetEmail({
      fullName: 'Jo',
      resetUrl: 'https://app.example.test/reset?token=abc',
      expiresInMinutes: 30,
    });
    expect(email.subject).toMatch(/Reset/);
    expect(email.text).toContain('https://app.example.test/reset?token=abc');
    expect(email.text).toContain('30 minutes');
  });
});
