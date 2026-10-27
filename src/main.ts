import { createApp } from "./app";
import { loadConfig } from "./config";
import { onGracefulShutdown } from "./core/shutdown";
import { disconnectDb, getPrisma } from "./db/client";

const config = loadConfig();
const prisma = getPrisma(config.databaseUrl);

if (process.env.RATE_LIMIT_DISABLED === "1")
  console.warn(
    "WARNING: RATE_LIMIT_DISABLED=1, login, register and subscribe are not rate limited",
  );

const app = createApp({ config, prisma });
const server = app.listen(config.port, () => {
  console.log(`api listening on :${config.port}`);
});

onGracefulShutdown("api", async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await disconnectDb();
});
