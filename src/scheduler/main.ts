import { loadConfig } from "../config";
import { getPool, getPrisma, disconnectDb } from "../db/client";
import { schedulerTick } from "../db/jobs";
import { sweepStatus } from "../db/sweeper";
import { systemClock } from "../core/clock";

const TICK_MS = 1000;
const SWEEP_MS = 5000; // stale results and override expiry only matter to the second, so no need to sweep every tick

async function loop(): Promise<void> {
  const config = loadConfig();
  const pool = getPool(config.databaseUrl);
  const prisma = getPrisma(config.databaseUrl);
  let lastSweep = 0;
  console.log("scheduler started");

  for (;;) {
    try {
      const { enqueued, skipped } = await schedulerTick(pool, systemClock);
      if (enqueued || skipped) {
        console.log(`tick: enqueued=${enqueued} skipped=${skipped}`);
      }
    } catch (err) {
      console.error("scheduler tick error", err);
    }
    if (Date.now() - lastSweep >= SWEEP_MS) {
      lastSweep = Date.now();
      try {
        const sweep = await sweepStatus(prisma, systemClock.now());
        if (
          sweep.statusChanges ||
          sweep.overridesEnded ||
          sweep.incidentsOpened ||
          sweep.failures
        ) {
          console.log(
            `sweep: statusChanges=${sweep.statusChanges} overridesEnded=${sweep.overridesEnded} incidentsOpened=${sweep.incidentsOpened} failures=${sweep.failures}`,
          );
        }
      } catch (err) {
        console.error("scheduler sweep error", err);
      }
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
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
