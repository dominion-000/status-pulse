import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDb,
  errorCode,
  hasTestDb,
  type TestDb,
} from "../helpers/test-db";

const UNIQUE = "23505";
const CHECK = "23514";

describe.skipIf(!hasTestDb)("status and incident schema (SP-04, SP-05)", () => {
  let t: TestDb;
  let userId: string;
  let projectId: string;
  let n = 0;

  beforeAll(async () => {
    t = await createTestDb();
    userId = (
      await t.client.query(
        `INSERT INTO users (email, password_hash) VALUES ('owner@example.com', 'x') RETURNING id`,
      )
    ).rows[0].id;
    projectId = (
      await t.client.query(
        `INSERT INTO projects (name, slug) VALUES ('p', 'p') RETURNING id`,
      )
    ).rows[0].id;
  });
  afterAll(async () => {
    await t?.close();
  });

  async function newService(): Promise<string> {
    n += 1;
    return (
      await t.client.query(
        `INSERT INTO services (project_id, name, url, interval_seconds, timeout_seconds) VALUES ($1, $2, 'https://example.com', 60, 5) RETURNING id`,
        [projectId, `svc-${n}`],
      )
    ).rows[0].id;
  }
  const openIncident = (serviceId: string, extra = "") =>
    t.client.query(
      `INSERT INTO incidents (project_id, service_id, title, origin ${extra ? ", " + extra.split("|")[0] : ""}) VALUES ($1, $2, 'down', 'auto' ${extra ? ", " + extra.split("|")[1] : ""}) RETURNING id`,
      [projectId, serviceId],
    );

  it("enables row level security on every table", async () => {
    const r = await t.client.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind = 'r' AND NOT c.relrowsecurity`,
      [t.schema],
    );
    expect(r.rows).toEqual([]);
  });

  it("gives new services an Unknown computed status and no result time", async () => {
    const id = await newService();
    const row = (
      await t.client.query(
        `SELECT computed_status, current_status, last_result_at, computed_since FROM services WHERE id = $1`,
        [id],
      )
    ).rows[0];
    expect(row.computed_status).toBe("Unknown");
    expect(row.current_status).toBe("Unknown");
    expect(row.last_result_at).toBeNull();
    expect(row.computed_since).toBeInstanceOf(Date);
  });

  describe("incidents: one active per service (SP-05.2)", () => {
    it("rejects a second active incident for the same service", async () => {
      const s = await newService();
      await openIncident(s);
      expect(
        await errorCode(
          t.client,
          `INSERT INTO incidents (project_id, service_id, title, origin) VALUES ($1, $2, 'again', 'auto')`,
          [projectId, s],
        ),
      ).toBe(UNIQUE);
    });

    it("rejects it whatever stage the active incident is in", async () => {
      const s = await newService();
      const id = (await openIncident(s)).rows[0].id;
      for (const stage of ["Identified", "Monitoring"]) {
        await t.client.query(`UPDATE incidents SET status = $2 WHERE id = $1`, [
          id,
          stage,
        ]);
        expect(
          await errorCode(
            t.client,
            `INSERT INTO incidents (project_id, service_id, title, origin) VALUES ($1, $2, 'again', 'auto')`,
            [projectId, s],
          ),
        ).toBe(UNIQUE);
      }
    });

    it("allows a new incident once the previous one is resolved", async () => {
      const s = await newService();
      const id = (await openIncident(s)).rows[0].id;
      await t.client.query(
        `UPDATE incidents SET status = 'Resolved', resolved_at = now(), resolved_by_user_id = $2 WHERE id = $1`,
        [id, userId],
      );
      expect(
        await errorCode(
          t.client,
          `INSERT INTO incidents (project_id, service_id, title, origin) VALUES ($1, $2, 'next', 'auto')`,
          [projectId, s],
        ),
      ).toBeNull();
    });

    it("allows active incidents on different services", async () => {
      await openIncident(await newService());
      expect(
        await errorCode(
          t.client,
          `INSERT INTO incidents (project_id, service_id, title, origin) VALUES ($1, $2, 'other', 'auto')`,
          [projectId, await newService()],
        ),
      ).toBeNull();
    });
  });

  describe("incident rules", () => {
    it.each([
      [
        "an unknown status",
        `INSERT INTO incidents (project_id, service_id, title, origin, status) VALUES ($1, $2, 't', 'auto', 'Closed')`,
      ],
      [
        "an unknown origin",
        `INSERT INTO incidents (project_id, service_id, title, origin) VALUES ($1, $2, 't', 'robot')`,
      ],
      [
        "a resolved incident without a resolution time",
        `INSERT INTO incidents (project_id, service_id, title, origin, status) VALUES ($1, $2, 't', 'auto', 'Resolved')`,
      ],
      [
        "a resolution time on an unresolved incident",
        `INSERT INTO incidents (project_id, service_id, title, origin, resolved_at) VALUES ($1, $2, 't', 'auto', now())`,
      ],
      [
        "a manual incident without who opened it",
        `INSERT INTO incidents (project_id, service_id, title, origin) VALUES ($1, $2, 't', 'manual')`,
      ],
    ])("rejects %s", async (_label, sql) => {
      expect(
        await errorCode(t.client, sql, [projectId, await newService()]),
      ).toBe(CHECK);
    });

    it("accepts a manual incident with an opener, private by default", async () => {
      const s = await newService();
      const r = await t.client.query(
        `INSERT INTO incidents (project_id, service_id, title, origin, opened_by_user_id) VALUES ($1, $2, 't', 'manual', $3) RETURNING is_public, status`,
        [projectId, s, userId],
      );
      expect(r.rows[0]).toEqual({ is_public: false, status: "Investigating" });
    });

    it("rejects empty or oversized update messages and unknown statuses", async () => {
      const id = (await openIncident(await newService())).rows[0].id;
      expect(
        await errorCode(
          t.client,
          `INSERT INTO incident_updates (incident_id, status, message) VALUES ($1, 'Investigating', '   ')`,
          [id],
        ),
      ).toBe(CHECK);
      expect(
        await errorCode(
          t.client,
          `INSERT INTO incident_updates (incident_id, status, message) VALUES ($1, 'Investigating', $2)`,
          [id, "x".repeat(2001)],
        ),
      ).toBe(CHECK);
      expect(
        await errorCode(
          t.client,
          `INSERT INTO incident_updates (incident_id, status, message) VALUES ($1, 'Closed', 'hi')`,
          [id],
        ),
      ).toBe(CHECK);
      expect(
        await errorCode(
          t.client,
          `INSERT INTO incident_updates (incident_id, status, message) VALUES ($1, 'Investigating', 'Looking into it')`,
          [id],
        ),
      ).toBeNull();
    });

    it("keeps updates internal unless marked public", async () => {
      const id = (await openIncident(await newService())).rows[0].id;
      const r = await t.client.query(
        `INSERT INTO incident_updates (incident_id, status, message) VALUES ($1, 'Investigating', 'internal note') RETURNING is_public`,
        [id],
      );
      expect(r.rows[0].is_public).toBe(false);
    });
  });

  describe("overrides (SP-04.5)", () => {
    const insert = `INSERT INTO status_overrides (service_id, status, reason, actor_user_id, expires_at) VALUES ($1, 'Operational', 'planned maintenance', $2, now() + interval '1 hour')`;

    it("allows only one active override per service", async () => {
      const s = await newService();
      expect(await errorCode(t.client, insert, [s, userId])).toBeNull();
      expect(await errorCode(t.client, insert, [s, userId])).toBe(UNIQUE);
    });

    it("allows a new override once the previous one has ended", async () => {
      const s = await newService();
      await t.client.query(insert, [s, userId]);
      await t.client.query(
        `UPDATE status_overrides SET ended_at = now(), end_reason = 'cancelled', ended_by_user_id = $2 WHERE service_id = $1`,
        [s, userId],
      );
      expect(await errorCode(t.client, insert, [s, userId])).toBeNull();
    });

    it("requires a real reason, an expiry in the future and a known status", async () => {
      const s = await newService();
      expect(
        await errorCode(
          t.client,
          `INSERT INTO status_overrides (service_id, status, reason, actor_user_id, expires_at) VALUES ($1, 'Operational', 'ok', $2, now() + interval '1 hour')`,
          [s, userId],
        ),
      ).toBe(CHECK);
      expect(
        await errorCode(
          t.client,
          `INSERT INTO status_overrides (service_id, status, reason, actor_user_id, expires_at) VALUES ($1, 'Operational', 'maintenance', $2, now() - interval '1 hour')`,
          [s, userId],
        ),
      ).toBe(CHECK);
      expect(
        await errorCode(
          t.client,
          `INSERT INTO status_overrides (service_id, status, reason, actor_user_id, expires_at) VALUES ($1, 'Fine', 'maintenance', $2, now() + interval '1 hour')`,
          [s, userId],
        ),
      ).toBe(CHECK);
    });

    it("keeps ended_at and end_reason together", async () => {
      const s = await newService();
      await t.client.query(insert, [s, userId]);
      expect(
        await errorCode(
          t.client,
          `UPDATE status_overrides SET ended_at = now() WHERE service_id = $1`,
          [s],
        ),
      ).toBe(CHECK);
      expect(
        await errorCode(
          t.client,
          `UPDATE status_overrides SET end_reason = 'expired' WHERE service_id = $1`,
          [s],
        ),
      ).toBe(CHECK);
    });
  });

  describe("status history", () => {
    it("accepts known sources and statuses and rejects others", async () => {
      const s = await newService();
      const ok = `INSERT INTO service_status_history (service_id, status, computed_status, source) VALUES ($1, 'Operational', 'Operational', $2)`;
      for (const source of ["computed", "stale", "disabled", "override"])
        expect(await errorCode(t.client, ok, [s, source])).toBeNull();
      expect(await errorCode(t.client, ok, [s, "guess"])).toBe(CHECK);
      expect(
        await errorCode(
          t.client,
          `INSERT INTO service_status_history (service_id, status, computed_status, source) VALUES ($1, 'Fine', 'Operational', 'computed')`,
          [s],
        ),
      ).toBe(CHECK);
    });
  });

  it("rejects an unknown computed status on a service", async () => {
    const s = await newService();
    expect(
      await errorCode(
        t.client,
        `UPDATE services SET computed_status = 'Fine' WHERE id = $1`,
        [s],
      ),
    ).toBe(CHECK);
  });

  it("removes incidents, updates, overrides and history with their service", async () => {
    const s = await newService();
    const incident = (await openIncident(s)).rows[0].id;
    await t.client.query(
      `INSERT INTO incident_updates (incident_id, status, message) VALUES ($1, 'Investigating', 'hello')`,
      [incident],
    );
    await t.client.query(
      `INSERT INTO status_overrides (service_id, status, reason, actor_user_id, expires_at) VALUES ($1, 'Operational', 'maintenance', $2, now() + interval '1 hour')`,
      [s, userId],
    );
    await t.client.query(
      `INSERT INTO service_status_history (service_id, status, computed_status, source) VALUES ($1, 'Outage', 'Outage', 'computed')`,
      [s],
    );
    await t.client.query(`DELETE FROM services WHERE id = $1`, [s]);
    for (const table of [
      "incidents",
      "status_overrides",
      "service_status_history",
    ]) {
      expect(
        (
          await t.client.query(
            `SELECT count(*)::int AS n FROM ${table} WHERE service_id = $1`,
            [s],
          )
        ).rows[0].n,
      ).toBe(0);
    }
    expect(
      (
        await t.client.query(
          `SELECT count(*)::int AS n FROM incident_updates WHERE incident_id = $1`,
          [incident],
        )
      ).rows[0].n,
    ).toBe(0);
  });
});
