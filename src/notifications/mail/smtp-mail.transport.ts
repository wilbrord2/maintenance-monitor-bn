import nodemailer, { type Transporter } from 'nodemailer';
import { type AppConfig } from '../../config/config';
import { type MailMessage, type MailTransport } from './mail.transport';
import { openSmtpSocket } from './smtp-socket';

const CONNECTION_TIMEOUT_MS = 10_000;

/** SMTP delivery through the configured company mail server. */
export class SmtpMailTransport implements MailTransport {
  private readonly transporter: Transporter;
  private readonly from: { name: string; address: string };

  constructor(config: AppConfig['mail']) {
    this.transporter = nodemailer.createTransport({
      pool: true,
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.username && config.password
        ? { auth: { user: config.username, pass: config.password } }
        : {}),
      // Open the TCP connection with IPv6/IPv4 racing so an unreachable IPv6 route
      // cannot stall delivery; nodemailer still performs TLS and SMTP on this socket.
      getSocket: (_options, callback) => {
        openSmtpSocket(config.host, config.port, CONNECTION_TIMEOUT_MS)
          .then((socket) => {
            callback(null, { connection: socket });
          })
          .catch((error: unknown) => {
            callback(error instanceof Error ? error : new Error(String(error)), false);
          });
      },
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      tls: { minVersion: 'TLSv1.2' },
    });
    this.from = { name: config.fromName, address: config.from };
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }

  async verify(): Promise<void> {
    await this.transporter.verify();
  }

  close(): void {
    this.transporter.close();
  }
}
