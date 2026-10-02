import { loadConfig } from "../config";
import { getPool, disconnectDb } from "../db/client";
import { schedulerTick } from "../db/jobs";
import { systemClock } from "../core/clock";

const TICK_MS = 1000;

async function loop(): Promise<void> {
  const config = loadConfig();
  const pool = getPool(config.databaseUrl);
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
