import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../prisma/generated";

// Database tests run against a real PostgreSQL:
// they exercise unique indexes, CHECK constraints and cascades.
// Each test file gets its own schema, built by applying the real prisma/migrations files in order.
export const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);

if (!hasTestDb) {
  throw new Error("DATABASE_URL_TEST is required");
}

export interface TestDb {
  client: pg.Client;
  schema: string;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST is not set");
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const local = /@(localhost|127\.0\.0\.1)(:|\/)/.test(url);
  const client = new pg.Client({
    connectionString: url,
    ...(local ? {} : { ssl: { rejectUnauthorized: false } }),
  });
  await client.connect();
  await client.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
  await client.query(`SET search_path TO ${pg.escapeIdentifier(schema)}`);

  const root = join(process.cwd(), "prisma", "migrations");
  const folders = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const folder of folders) {
    let sql = readFileSync(join(root, folder, "migration.sql"), "utf8");
    // Embedded Postgres builds used in some sandboxes ship without pgcrypto.
    // gen_random_uuid() is built into PostgreSQL 13+, so the extension is optional here.
    sql = sql.replace(
      /CREATE EXTENSION IF NOT EXISTS ["']?pgcrypto["']?;/gi,
      "-- pgcrypto unavailable in some embeds; gen_random_uuid is core since PG13",
    );
    await client.query(sql);
  }

  return {
    client,
    schema,
    async close() {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA ${pg.escapeIdentifier(schema)} CASCADE`);
      await client.end();
    },
  };
}

export async function errorCode(
  client: pg.Client,
  sql: string,
  params: unknown[] = [],
): Promise<string | null> {
  try {
    await client.query(sql, params);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

export function prismaFor(t: TestDb): {
  prisma: PrismaClient;
  pool: pg.Pool;
  close(): Promise<void>;
} {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST is not set");
  const local = /@(localhost|127\.0\.0\.1)(:|\/)/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    ...(local ? {} : { ssl: { rejectUnauthorized: false } }),
  });
  pool.on(
    "connect",
    (c) => void c.query(`SET search_path TO ${pg.escapeIdentifier(t.schema)}`),
  );
  const prisma = new PrismaClient({
    adapter: new PrismaPg(pool, { schema: t.schema }),
  });
  return {
    prisma,
    pool,
    async close() {
      await prisma.$disconnect();
      await pool.end();
    },
  };
}
