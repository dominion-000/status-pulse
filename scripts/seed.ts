/**
 * Bootstrap the first platform admin only when none exist.
 *
 *   ADMIN_EMAIL=you@example.com pnpm seed
 */
import { loadConfig } from "../src/config";
import { getPrisma, disconnectDb } from "../src/db/client";

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = getPrisma(config.databaseUrl);
  const adminEmail = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  if (!adminEmail) {
    console.log(
      "Set ADMIN_EMAIL for first-admin bootstrap (only when no admins exist).",
    );
    return;
  }
  const existing = await prisma.user.count({ where: { isAdmin: true } });
  if (existing > 0) {
    console.error(
      `Refusing: ${existing} admin(s) already exist. Grant more from the admin UI.`,
    );
    process.exitCode = 1;
    return;
  }
  const user = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!user) {
    console.error(`No user ${adminEmail}. Register via the API/UI first.`);
    process.exitCode = 1;
    return;
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { isAdmin: true },
  });
  console.log(`Bootstrapped first platform admin: ${adminEmail}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => disconnectDb());
