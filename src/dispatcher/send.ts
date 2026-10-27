/**
 * Outbound mail for the dispatcher.
 * Production / staging: Resend (RESEND_API_KEY required).
 * Automated tests: in-process test sender (no network). fail.example always fails there.
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

function isTestEnv(env: NodeJS.ProcessEnv): boolean {
  return (
    env.NODE_ENV === "test" ||
    env.VITEST === "true" ||
    env.MAIL_PROVIDER === "test"
  );
}

async function sendWithResend(
  apiKey: string,
  from: string,
  message: MailMessage,
): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [message.to],
      subject: message.subject,
      text: message.body,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new MailSendError(
      `Resend HTTP ${res.status}: ${text.slice(0, 200) || res.statusText}`,
    );
  }
}

/**
 * Builds the process mail sender.
 * - test env: local no-op success, except fail.example (and MAIL_FAIL_ALL for regression tests)
 * - otherwise: Resend only; missing key is a hard error when sending
 */
export function createDefaultSender(
  env: NodeJS.ProcessEnv = process.env,
): MailSender {
  const failAll = env.MAIL_FAIL_ALL === "1" || env.MAIL_FAIL_ALL === "true";
  const apiKey = (env.RESEND_API_KEY ?? "").trim();
  const from = (env.MAIL_FROM ?? "").trim() || "Status Pulse <onboarding@resend.dev>";

  return async (message: MailMessage): Promise<void> => {
    if (failAll) {
      throw new MailSendError("MAIL_FAIL_ALL is set");
    }
    if (domainOf(message.to) === "fail.example") {
      throw new MailSendError(`recipient domain fail.example: ${message.to}`);
    }

    if (isTestEnv(env) && !apiKey) {
      return;
    }

    if (!apiKey) {
      throw new MailSendError(
        "RESEND_API_KEY is not configured; set it to send email",
      );
    }
    await sendWithResend(apiKey, from, message);
  };
}
