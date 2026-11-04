import { systemClock } from "../core/clock";
import { loadConfig } from "../config";
import type { Pool, PoolClient } from "pg";
import { getPool, disconnectDb } from "../db/client";
import { onGracefulShutdown } from "../core/shutdown";
import {
  claimOutboxMessage,
  markOutboxDelivered,
  markOutboxFailed,
  outboxBackoffSeconds,
} from "../db/outbox";
import { createDefaultSender, type MailSender } from "./send";
import { emailShell } from "./email-html";

const TICK_MS = 1000;

/**
 * One dispatcher tick: claim at most one pending message, attempt delivery,
 * and record success or failure with backoff.
 * Returns true when a message was claimed (whether or not the send succeeded).
 */
export async function dispatcherTick(
  pool: Pool | PoolClient,
  sender: MailSender,
  now: Date = systemClock.now(),
  leaseSeconds = 30,
  maxAttempts = 6,
): Promise<boolean> {
  const msg = await claimOutboxMessage(pool, now, leaseSeconds, maxAttempts);
  if (!msg) return false;

  try {
    const htmlBody = msg.body
      .split("\n")
      .map((line) =>
        line.trim()
          ? `<p style="margin:0 0 18px;font-size:14px;line-height:1.65;color:#c5d0dc;">${escapeXml(line)}</p>`
          : `<p style="margin:0 0 10px;line-height:0.5;">&nbsp;</p>`,
      )
      .join("");
    await sender({
      to: msg.recipient_email,
      subject: msg.subject,
      body: msg.body,
      html: emailShell(htmlBody || `<p style="margin:0;color:#c5d0dc;">${escapeXml(msg.body)}</p>`),
    });
    await markOutboxDelivered(pool, msg.id, now);
    console.log(
      `dispatcher: delivered ${msg.id} to ${msg.recipient_email} (attempt ${msg.attempts})`,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const delay = outboxBackoffSeconds(msg.attempts);
    const next = new Date(now.getTime() + delay * 1000);
    await markOutboxFailed(pool, msg.id, reason, next);
    console.log(
      `dispatcher: failed ${msg.id} to ${msg.recipient_email} attempt=${msg.attempts} next=${next.toISOString()} reason=${reason}`,
    );
  }
  return true;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = getPool(config.databaseUrl);
  const sender = createDefaultSender();
  console.log("dispatcher: started");

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await dispatcherTick(
        pool,
        sender,
        systemClock.now(),
        config.dispatcherLeaseSeconds,
        config.dispatcherMaxAttempts,
      );
    } catch (err) {
      console.error("dispatcher tick error", err);
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

onGracefulShutdown("dispatcher", async () => {
  await disconnectDb();
});

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
