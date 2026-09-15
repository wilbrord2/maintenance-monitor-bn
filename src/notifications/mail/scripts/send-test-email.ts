/**
 * Sends one test email with the configured MAIL_* settings and explains failures.
 *
 *   npm run mail:test -- someone@example.com
 *
 * Without a recipient, the email goes to MAIL_FROM. The SMTP password is never printed.
 */
import 'dotenv/config';
import { z } from 'zod';
import { loadConfig } from '../../../config/config';
import { SmtpMailTransport } from '../smtp-mail.transport';

const print = (line = '') => process.stdout.write(`${line}\n`);

interface SmtpErrorInfo {
  readonly message: string;
  readonly code?: string;
  readonly responseCode?: number;
}

function describeError(error: unknown): SmtpErrorInfo {
  if (!(error instanceof Error)) return { message: String(error) };
  const { code, responseCode } = error as { code?: unknown; responseCode?: unknown };
  return {
    message: error.message,
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof responseCode === 'number' ? { responseCode } : {}),
  };
}

function hintFor(info: SmtpErrorInfo, host: string, port: number, secure: boolean): string[] {
  const gmail = host.toLowerCase().includes('gmail');
  if (info.message.includes('ECONNREFUSED')) {
    return [
      `Nothing is listening on ${host}:${port}.`,
      port === 1025
        ? 'Port 1025 is the local Mailpit test server: start it with `docker run -d -p 1025:1025 -p 8025:8025 axllent/mailpit` (inbox at http://localhost:8025), or switch MAIL_* to a real SMTP server such as Gmail.'
        : 'Check MAIL_HOST and MAIL_PORT.',
    ];
  }
  if (info.code === 'EAUTH' || info.responseCode === 535 || info.responseCode === 534) {
    return gmail
      ? [
          'Gmail rejected the username/password.',
          'Your normal Google password does not work over SMTP. Turn on 2-Step Verification, create an App Password',
          '(Google Account → Security → App passwords) and put the 16 characters, without spaces, in MAIL_PASSWORD.',
          'MAIL_USERNAME must be the full Gmail address.',
        ]
      : ['The SMTP server rejected MAIL_USERNAME / MAIL_PASSWORD.'];
  }
  if (/wrong version number|ssl3_get_record|EPROTO/i.test(info.message)) {
    return [
      `TLS mode mismatch: port ${port} with MAIL_SECURE=${secure}.`,
      'Use MAIL_PORT=465 with MAIL_SECURE=true, or MAIL_PORT=587 with MAIL_SECURE=false.',
    ];
  }
  if (info.code === 'ETIMEDOUT' || /timeout/i.test(info.message)) {
    return [
      'The connection timed out.',
      'Check that the port is not blocked by your network/firewall and that MAIL_SECURE matches the port (465 → true, 587 → false).',
    ];
  }
  if (info.code === 'EENVELOPE' || info.responseCode === 553 || info.responseCode === 550) {
    return [
      'The server refused the sender or recipient. For Gmail, MAIL_FROM must be the Gmail address itself.',
    ];
  }
  return ['See the error above.'];
}

async function main(): Promise<number> {
  const config = loadConfig();
  const { mail } = config;
  const recipientInput = process.argv[2] ?? mail.from;
  const recipient = z.email().safeParse(recipientInput);
  if (!recipient.success) {
    print(`"${recipientInput}" is not a valid email address.`);
    print('Usage: npm run mail:test -- someone@example.com');
    return 1;
  }

  print('SMTP settings');
  print(`  host      ${mail.host}:${mail.port}`);
  print(`  secure    ${mail.secure ? 'true (implicit TLS)' : 'false (STARTTLS when offered)'}`);
  print(`  username  ${mail.username ?? '(none)'}`);
  print(`  password  ${mail.password ? '(set)' : '(not set)'}`);
  print(`  from      ${mail.fromName} <${mail.from}>`);
  print(`  to        ${recipient.data}`);
  print();

  const transport = new SmtpMailTransport(mail);
  try {
    let started = Date.now();
    print('1/2 Connecting and authenticating…');
    await transport.verify();
    print(`    ok (${Date.now() - started} ms)`);

    started = Date.now();
    print('2/2 Sending test email…');
    await transport.send({
      to: recipient.data,
      subject: 'Maintenance Monitor — test email',
      text: `This is a test email from Maintenance Monitor, sent at ${new Date().toISOString()}.\nYour SMTP settings work.`,
      html: `<p>This is a test email from <strong>Maintenance Monitor</strong>, sent at ${new Date().toISOString()}.</p><p>Your SMTP settings work.</p>`,
    });
    print(`    sent (${Date.now() - started} ms). Check the inbox (and spam folder) of ${recipient.data}.`);
    return 0;
  } catch (error: unknown) {
    const info = describeError(error);
    print();
    print(`FAILED: ${info.message}`);
    if (info.code)
      print(`  code: ${info.code}${info.responseCode ? `, SMTP response ${info.responseCode}` : ''}`);
    print();
    for (const line of hintFor(info, mail.host, mail.port, mail.secure)) print(`  → ${line}`);
    return 1;
  } finally {
    transport.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    print(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
