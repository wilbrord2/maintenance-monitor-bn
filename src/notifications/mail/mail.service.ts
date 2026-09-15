import { type AppLogger } from '../../common/logger/logger';
import { type MailTransport } from './mail.transport';
import {
  passwordChangedEmail,
  passwordResetEmail,
  technicianOnboardingEmail,
} from './templates/auth.templates';
import { type RenderedEmail } from './templates/layout';

/** Composes and delivers application emails. Never logs message bodies (they may hold credentials). */
export class MailService {
  constructor(
    private readonly transport: MailTransport,
    private readonly logger: AppLogger,
  ) {}

  async sendTechnicianOnboarding(input: {
    to: string;
    fullName: string;
    temporaryPassword: string;
    expiresAt: Date;
    loginUrl: string;
  }): Promise<void> {
    await this.deliver(
      input.to,
      'technician-onboarding',
      technicianOnboardingEmail({
        fullName: input.fullName,
        email: input.to,
        temporaryPassword: input.temporaryPassword,
        expiresAt: input.expiresAt,
        loginUrl: input.loginUrl,
      }),
    );
  }

  async sendPasswordReset(input: {
    to: string;
    fullName: string;
    resetUrl: string;
    expiresInMinutes: number;
  }): Promise<void> {
    await this.deliver(input.to, 'password-reset', passwordResetEmail(input));
  }

  async sendPasswordChanged(input: { to: string; fullName: string; changedAt: Date }): Promise<void> {
    await this.deliver(input.to, 'password-changed', passwordChangedEmail(input));
  }

  private async deliver(to: string, template: string, email: RenderedEmail): Promise<void> {
    try {
      await this.transport.send({ to, subject: email.subject, text: email.text, html: email.html });
      this.logger.info({ template }, 'Email sent');
    } catch (error: unknown) {
      this.logger.error({ template, err: error }, 'Email delivery failed');
      throw error;
    }
  }
}
