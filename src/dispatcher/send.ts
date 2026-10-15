/**
 * Simulated mail sender used by the dispatcher.
 * Real SMTP is never used. Failures are deterministic.
 */

export interface MailMessage {
  to: string;
  subject: string;
  body: string;
}

export type MailSender = (message: MailMessage) => Promise<void>;

export class MailSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailSendError";
  }
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
}

/**
 * Default sender. Throws MailSendError when the address is on fail.example
 * or when the environment switch is set.
 */
export function createDefaultSender(
  env: NodeJS.ProcessEnv = process.env,
): MailSender {
  const failAll = env.MAIL_FAIL_ALL === "1" || env.MAIL_FAIL_ALL === "true";
  return async (message: MailMessage): Promise<void> => {
    if (failAll) {
      throw new MailSendError("MAIL_FAIL_ALL is set");
    }
    if (domainOf(message.to) === "fail.example") {
      throw new MailSendError(`recipient domain fail.example: ${message.to}`);
    }
    // Success: nothing to do. A real implementation would hand off to a provider.
  };
}
