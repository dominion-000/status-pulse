import { PrismaClient } from "../../prisma/generated";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

let prisma: PrismaClient | null = null;
let pool: pg.Pool | null = null;

/** Shared Prisma client using the pg driver adapter (Prisma 7). */
export function getPrisma(databaseUrl?: string): PrismaClient {
  if (prisma) return prisma;
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  pool = new pg.Pool({ connectionString: url, max: 5 });
  const adapter = new PrismaPg(pool);
  prisma = new PrismaClient({ adapter });
  return prisma;
}

/** Raw pg pool for SKIP LOCKED / FOR UPDATE queries Prisma cannot express. */
export function getPool(databaseUrl?: string): pg.Pool {
  if (pool) return pool;
  getPrisma(databaseUrl);
  if (!pool) throw new Error("pool not initialised");
  return pool;
}

export async function disconnectDb(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** For tests: replace the singleton (or clear it). */
export function setPrismaForTests(client: PrismaClient | null): void {
  prisma = client;
}
