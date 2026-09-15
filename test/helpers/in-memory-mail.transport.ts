import { type MailMessage, type MailTransport } from '../../src/notifications/mail/mail.transport';

/** Test double capturing outbound email instead of delivering it. */
export class InMemoryMailTransport implements MailTransport {
  readonly sent: MailMessage[] = [];
  failSend = false;
  failVerify = false;

  send(message: MailMessage): Promise<void> {
    if (this.failSend) return Promise.reject(new Error('SMTP delivery failed'));
    this.sent.push(message);
    return Promise.resolve();
  }

  verify(): Promise<void> {
    return this.failVerify ? Promise.reject(new Error('SMTP unreachable')) : Promise.resolve();
  }

  close(): void {
    // Nothing to release.
  }

  lastTo(address: string): MailMessage | undefined {
    return [...this.sent].reverse().find((message) => message.to === address);
  }

  clear(): void {
    this.sent.length = 0;
    this.failSend = false;
    this.failVerify = false;
  }
}
