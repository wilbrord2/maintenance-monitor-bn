import { escapeHtml, htmlLayout, type RenderedEmail } from './layout';

function formatDate(date: Date): string {
  return `${date.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

export function technicianOnboardingEmail(input: {
  fullName: string;
  email: string;
  temporaryPassword: string;
  expiresAt: Date;
  loginUrl: string;
}): RenderedEmail {
  const subject = 'Your Maintenance Monitor account';
  const text = [
    `Hello ${input.fullName},`,
    '',
    'An administrator has created a Maintenance Monitor technician account for you.',
    '',
    `Login email: ${input.email}`,
    `Temporary password: ${input.temporaryPassword}`,
    `Expires: ${formatDate(input.expiresAt)}`,
    '',
    `Sign in at ${input.loginUrl}. You will be asked to choose a new password before you can continue.`,
    'Do not share this password. If it expires, ask your administrator to issue a new one.',
  ].join('\n');
  const html = htmlLayout(
    subject,
    `<p>Hello ${escapeHtml(input.fullName)},</p>
     <p>An administrator has created a Maintenance Monitor technician account for you.</p>
     <p><strong>Login email:</strong> ${escapeHtml(input.email)}<br>
        <strong>Temporary password:</strong> <code style="font-size:15px;">${escapeHtml(input.temporaryPassword)}</code><br>
        <strong>Expires:</strong> ${escapeHtml(formatDate(input.expiresAt))}</p>
     <p><a href="${escapeHtml(input.loginUrl)}">Sign in</a>. You will be asked to choose a new password before you can continue.</p>
     <p>Do not share this password. If it expires, ask your administrator to issue a new one.</p>`,
  );
  return { subject, text, html };
}

export function passwordResetEmail(input: {
  fullName: string;
  resetUrl: string;
  expiresInMinutes: number;
}): RenderedEmail {
  const subject = 'Reset your Maintenance Monitor password';
  const text = [
    `Hello ${input.fullName},`,
    '',
    'We received a request to reset your password. Use the link below to choose a new one:',
    input.resetUrl,
    '',
    `The link expires in ${input.expiresInMinutes} minutes and can be used once.`,
    'If you did not request this, you can ignore this email; your password will not change.',
  ].join('\n');
  const html = htmlLayout(
    subject,
    `<p>Hello ${escapeHtml(input.fullName)},</p>
     <p>We received a request to reset your password.</p>
     <p><a href="${escapeHtml(input.resetUrl)}" style="display:inline-block;padding:10px 18px;background:#1b2430;color:#ffffff;text-decoration:none;">Reset password</a></p>
     <p>The link expires in ${input.expiresInMinutes} minutes and can be used once.</p>
     <p>If you did not request this, you can ignore this email; your password will not change.</p>`,
  );
  return { subject, text, html };
}

export function passwordChangedEmail(input: { fullName: string; changedAt: Date }): RenderedEmail {
  const subject = 'Your Maintenance Monitor password was changed';
  const text = [
    `Hello ${input.fullName},`,
    '',
    `Your password was changed at ${formatDate(input.changedAt)} and all other sessions were signed out.`,
    'If you did not make this change, contact your administrator immediately.',
  ].join('\n');
  const html = htmlLayout(
    subject,
    `<p>Hello ${escapeHtml(input.fullName)},</p>
     <p>Your password was changed at ${escapeHtml(formatDate(input.changedAt))} and all other sessions were signed out.</p>
     <p>If you did not make this change, contact your administrator immediately.</p>`,
  );
  return { subject, text, html };
}
