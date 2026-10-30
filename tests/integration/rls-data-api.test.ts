import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDb,
  hasTestDb,
  prismaFor,
  type TestDb,
} from "../helpers/test-db";

/**
 * SP-101Y — Row level security blocks the Supabase Data API style access path.
 *
 * Tables have RLS enabled and no permissive policies. A role without BYPASSRLS
 * (as used by PostgREST for anon and authenticated) therefore sees zero rows
 * even when the table contains data. The application connects with a privileged
 * role and is unaffected.
 */
describe.skipIf(!hasTestDb)(
  "row level security blocks the Data API (SP-101Y)",
  () => {
    let t: TestDb;
    let p: ReturnType<typeof prismaFor>;
    const role = "status_pulse_data_api";

    beforeAll(async () => {
      t = await createTestDb();
      p = prismaFor(t);

      await p.prisma.user.create({
        data: {
          email: "rls-seed@example.com",
          passwordHash: "x",
          name: "RLS Seed",
        },
      });

      await t.client.query(`DROP ROLE IF EXISTS ${role}`);
      await t.client.query(`CREATE ROLE ${role} NOBYPASSRLS`);
      await t.client.query(`GRANT USAGE ON SCHEMA ${t.schema} TO ${role}`);
      await t.client.query(
        `GRANT SELECT ON ALL TABLES IN SCHEMA ${t.schema} TO ${role}`,
      );
    });

    afterAll(async () => {
      try {
        await t.client.query("RESET ROLE");
        await t.client.query(`REASSIGN OWNED BY ${role} TO CURRENT_USER`);
        await t.client.query(`DROP OWNED BY ${role}`);
        await t.client.query(`DROP ROLE IF EXISTS ${role}`);
      } catch {
        // schema drop cleans up
      }
      await p?.close();
      await t?.close();
    });

    it("privileged connection still reads application data", async () => {
      const users = await p.prisma.user.findMany();
      expect(users.length).toBeGreaterThanOrEqual(1);
    });

    it("a non-bypass role sees no rows on RLS-protected tables", async () => {
      await t.client.query(`SET ROLE ${role}`);
      try {
        const tables = [
          "users",
          "projects",
          "services",
          "memberships",
          "audit_log",
          "check_jobs",
          "check_results",
          "incidents",
          "alerts",
          "outbox_messages",
          "subscribers",
        ];
        for (const table of tables) {
          const res = await t.client.query(
            `SELECT count(*)::int AS n FROM ${table}`,
          );
          expect(res.rows[0].n, table).toBe(0);
        }
      } finally {
        await t.client.query("RESET ROLE");
      }
    });

    it("RLS is enabled on the core tables", async () => {
      const res = await t.client.query(
        `
      SELECT c.relname AS table_name, c.relrowsecurity AS rls
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relkind = 'r'
        AND c.relname = ANY($1::text[])
      ORDER BY c.relname
      `,
        [
          [
            "users",
            "projects",
            "services",
            "memberships",
            "audit_log",
            "alerts",
            "outbox_messages",
            "subscribers",
          ],
        ],
      );
      expect(res.rows.length).toBeGreaterThanOrEqual(8);
      for (const row of res.rows) {
        expect(row.rls, row.table_name).toBe(true);
      }
    });
  },
);
