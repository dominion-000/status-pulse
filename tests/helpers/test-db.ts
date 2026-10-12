import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);

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
    await client.query(
      readFileSync(join(root, folder, "migration.sql"), "utf8"),
    );
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

/** The Postgres error code of a failing statement, or null if it succeeded. 23505 unique, 23514 check, 23503 foreign key. */
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
