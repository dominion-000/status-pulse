import { loadConfig } from "../config";
import { getPrisma, getPool, disconnectDb } from "../db/client";
import { claimJob, markJobDone } from "../db/jobs";
import { systemClock } from "../core/clock";
import { decryptSecret } from "../core/secrets";
import { runHttpCheck } from "./http-check";

const POLL_MS = 500;

async function processOne(): Promise<boolean> {
  const config = loadConfig();
  const pool = getPool(config.databaseUrl);
  const prisma = getPrisma(config.databaseUrl);
  const now = systemClock.now();

  const job = await claimJob(pool, now, config.workerLeaseSeconds, config.workerMaxAttempts);
  if (!job) return false;

  const service = await prisma.service.findUnique({ where: { id: job.service_id } });
  if (!service || !service.enabled || service.deletedAt) {
    await markJobDone(pool, job.id);
    return true;
  }

  let authorization: string | undefined;
  if (service.credentialsEnc) {
    try {
      authorization = decryptSecret(Buffer.from(service.credentialsEnc), config.credentialsEncKey);
    } catch {
      // Treat decrypt failure as a failed check
    }
  }

  const checkInput: Parameters<typeof runHttpCheck>[0] = {
    url: service.url,
    method: service.method,
    timeoutSeconds: service.timeoutSeconds,
    expectedStatusCodes: service.expectedStatusCodes,
    expectedBodyText: service.expectedBodyText,
  };
  if (authorization !== undefined) checkInput.authorization = authorization;
  const outcome = await runHttpCheck(checkInput);

  // Save result; unique on job_id prevents duplicates on retry (SP-03.3)
  try {
    await prisma.$transaction(async (tx) => {
      await tx.checkResult.create({
        data: {
          jobId: job.id,
          serviceId: service.id,
          statusCode: outcome.statusCode,
          latencyMs: outcome.latencyMs,
          passed: outcome.passed,
          failureReason: outcome.failureReason,
          configVersion: service.version,
          checkedAt: systemClock.now(),
        },
      });
      // Week 2: store result only; status evaluation (evaluate) is Week 3.
      // Still surface a simple status so the API has something to show.
      if (outcome.passed && service.currentStatus === "Unknown") {
        await tx.service.update({
          where: { id: service.id },
          data: { currentStatus: "Operational", statusSince: systemClock.now() },
        });
      } else if (!outcome.passed && service.currentStatus === "Operational") {
        // Do not jump to Outage without threshold logic (Week 3); leave as-is
      }
      await tx.$executeRawUnsafe(
        `UPDATE check_jobs SET status = 'done', lease_until = NULL WHERE id = $1::uuid`,
        job.id,
      );
    });
  } catch (err: unknown) {
    // Unique violation on job_id → another worker already wrote the result
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unique constraint") || message.includes("duplicate key")) {
      await markJobDone(pool, job.id);
    } else {
      console.error("worker save failed", job.id, err);
      // Leave leased; lease expiry allows retry
    }
  }

  return true;
}

async function loop(): Promise<void> {
  console.log("worker started");
  for (;;) {
    try {
      const worked = await processOne();
      if (!worked) await new Promise((r) => setTimeout(r, POLL_MS));
    } catch (err) {
      console.error("worker tick error", err);
      await new Promise((r) => setTimeout(r, POLL_MS * 2));
    }
  }
}

process.on("SIGINT", async () => {
  await disconnectDb();
  process.exit(0);
});

loop().catch(async (err) => {
  console.error(err);
  await disconnectDb();
  process.exit(1);
});
