import { createApp } from "./app";
import { loadConfig } from "./config";
import { getPrisma } from "./db/client";

const config = loadConfig();
const prisma = getPrisma(config.databaseUrl);

const app = createApp({ config, prisma });
app.listen(config.port, () => {
  console.log(`api listening on :${config.port}`);
});
