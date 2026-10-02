/**
 * Seed demonstration accounts and a sample project/service for the shared environment.
 * Usage: DATABASE_URL=... CREDENTIALS_ENC_KEY=... JWT_SECRET=... node dist/scripts/seed.js
 */
import { loadConfig } from "../config";
import { getPrisma, disconnectDb } from "../db/client";
import { hashPassword } from "../core/password";

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = getPrisma(config.databaseUrl);

  const email = "demo@statuspulse.local";
  const password = "correct horse battery";

  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(password),
        name: "Demo Owner",
      },
    });
    console.log(`created user ${email}`);
  } else {
    console.log(`user ${email} already exists`);
  }

  let project = await prisma.project.findUnique({ where: { slug: "demo" } });
  if (!project) {
    project = await prisma.project.create({ data: { name: "Demo Project", slug: "demo" } });
    await prisma.membership.create({
      data: { projectId: project.id, userId: user.id, role: "Owner" },
    });
    console.log("created project demo");
  }

  const existing = await prisma.service.findFirst({
    where: { projectId: project.id, name: "Example HTTPBin" },
  });
  if (!existing) {
    await prisma.service.create({
      data: {
        projectId: project.id,
        name: "Example HTTPBin",
        url: "https://httpbin.org/status/200",
        method: "GET",
        intervalSeconds: 60,
        timeoutSeconds: 10,
        expectedStatusCodes: [200],
        isPublic: true,
        version: 1,
      },
    });
    console.log("created sample service");
  }

  console.log("seed complete");
  console.log(`login: ${email} / ${password}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => disconnectDb());
