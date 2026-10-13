import { loadConfig } from "../config";
import { getPrisma, getPool, disconnectDb } from "../db/client";
import { claimJob, markJobDone } from "../db/jobs";
import { recordCheckResult } from "../db/record-result";
import { systemClock } from "../core/clock";
import { decryptSecret } from "../core/secrets";
import { runHttpCheck } from "./http-check";

const POLL_MS = 500;

async function processOne(): Promise<boolean> {
  const config = loadConfig();
  const pool = getPool(config.databaseUrl);
  const prisma = getPrisma(config.databaseUrl);
  const now = systemClock.now();

  const job = await claimJob(
    pool,
    now,
    config.workerLeaseSeconds,
    config.workerMaxAttempts,
  );
  if (!job) return false;

  const service = await prisma.service.findUnique({
    where: { id: job.service_id },
  });
  if (!service || !service.enabled || service.deletedAt) {
    await markJobDone(pool, job.id);
    return true;
  }

  let authorization: string | undefined;
  if (service.credentialsEnc) {
    try {
      authorization = decryptSecret(
        Buffer.from(service.credentialsEnc),
        config.credentialsEncKey,
      );
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

  // One transaction saves the result, closes the job, recalculates the status and opens an incident if needed.
  try {
    const recorded = await recordCheckResult(prisma, {
      jobId: job.id,
      serviceId: service.id,
      configVersion: service.version,
      outcome,
      checkedAt: systemClock.now(),
    });
    const change = recorded.change;
    if (change?.displayedChanged) {
      console.log(
        `status ${change.previousDisplayed} -> ${change.evaluation.displayed} (service ${service.id})`,
      );
    }
    if (recorded.incidentId)
      console.log(
        `incident opened ${recorded.incidentId} (service ${service.id})`,
      );
  } catch (err: unknown) {
    // Nothing was written. The job stays leased and is retried when its lease expires, if its slot is still current.
    console.error("worker save failed", job.id, err);
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
