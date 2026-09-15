export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Delivery mechanism for outbound email. */
export interface MailTransport {
  send(message: MailMessage): Promise<void>;
  /** Confirms the transport can reach and authenticate with the mail server. */
  verify(): Promise<void>;
  close(): void;
}
