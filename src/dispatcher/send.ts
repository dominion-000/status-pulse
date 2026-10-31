/**
 * Outbound mail via Brevo (API).
 * Tests use an in-process sender only when NODE_ENV=test / VITEST / MAIL_PROVIDER=test.
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

function parseFrom(raw: string): { email: string; name: string } {
  const m = raw.match(/^\s*(.*)<([^>]+)>\s*$/);
  if (m && m[1] !== undefined && m[2] !== undefined) {
    return {
      name: m[1].trim() || "Status Pulse",
      email: m[2].trim(),
    };
  }
  if (raw.includes("@")) return { name: "Status Pulse", email: raw.trim() };
  return { name: "Status Pulse", email: raw.trim() };
}

async function sendWithBrevo(
  apiKey: string,
  fromEmail: string,
  fromName: string,
  message: MailMessage,
): Promise<void> {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender: { email: fromEmail, name: fromName },
      to: [{ email: message.to }],
      subject: message.subject,
      textContent: message.body,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new MailSendError(
      `Brevo HTTP ${res.status}: ${text.slice(0, 300) || res.statusText}`,
    );
  }
}

export function createDefaultSender(
  env: NodeJS.ProcessEnv = process.env,
): MailSender {
  const failAll = env.MAIL_FAIL_ALL === "1" || env.MAIL_FAIL_ALL === "true";

  if (isTestEnv(env)) {
    return async (message) => {
      if (failAll || domainOf(message.to) === "fail.example") {
        throw new MailSendError("simulated send failure");
      }
    };
  }

  const apiKey = (env.BREVO_API_KEY ?? "").trim();
  if (!apiKey) {
    return async () => {
      throw new MailSendError(
        "BREVO_API_KEY is not configured; set it to send email",
      );
    };
  }

  const fromRaw = (env.MAIL_FROM ?? "").trim();
  if (!fromRaw) {
    return async () => {
      throw new MailSendError(
        "MAIL_FROM is not configured; use your Brevo-validated sender email",
      );
    };
  }

  const { email, name } = parseFrom(fromRaw);

  return async (message) => {
    if (failAll) throw new MailSendError("MAIL_FAIL_ALL is set");
    await sendWithBrevo(apiKey, email, name, message);
  };
}
