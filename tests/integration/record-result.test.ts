import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIncidentIfNeeded } from "../../src/db/incidents";
import { recordCheckResult } from "../../src/db/record-result";
import { lockService, refreshStatus } from "../../src/db/service-status";
import {
  createTestDb,
  hasTestDb,
  prismaFor,
  type TestDb,
} from "../helpers/test-db";

const T0 = new Date("2026-10-11T12:00:00Z").getTime();
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
type Kind = "p" | "s" | "f";

describe.skipIf(!hasTestDb)(
  "recording a check result (SP-03.3, SP-04, SP-05)",
  () => {
    let t: TestDb;
    let p: ReturnType<typeof prismaFor>;
    let userId: string;
    let projectId: string;
    let n = 0;
    let minute = 0;

    beforeAll(async () => {
      t = await createTestDb();
      p = prismaFor(t);
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
      await t.client.query(
        `UPDATE projects SET plan_id = (SELECT id FROM plans WHERE name = 'pro') WHERE id = $1`,
        [projectId],
      );
    });
    afterAll(async () => {
      await p?.close();
      await t?.close();
    });

    async function newService(isPublic = false): Promise<string> {
      n += 1;
      return (
        await t.client.query(
          `INSERT INTO services (project_id, name, url, interval_seconds, timeout_seconds, fail_threshold, recovery_threshold, slow_threshold, degraded_ms, is_public, status_since, computed_since)
         VALUES ($1, $2, 'https://example.com', 60, 5, 3, 2, 3, 1000, $3, $4, $4) RETURNING id`,
          [projectId, `svc-${n}`, isPublic, at(-24 * 60)],
        )
      ).rows[0].id;
    }

    /** A claimed job, as the worker sees it after claimJob. */
    async function newJob(
      serviceId: string,
    ): Promise<{ id: string; at: Date }> {
      minute += 1;
      const when = at(minute);
      const id = (
        await t.client.query(
          `INSERT INTO check_jobs (service_id, scheduled_for, status, attempts) VALUES ($1, $2, 'leased', 1) RETURNING id`,
          [serviceId, when],
        )
      ).rows[0].id;
      return { id, at: when };
    }

    const outcome = (kind: Kind) =>
      kind === "f"
        ? {
            statusCode: 500,
            latencyMs: 40,
            passed: false,
            failureReason: "status 500",
          }
        : {
            statusCode: 200,
            latencyMs: kind === "s" ? 2500 : 120,
            passed: true,
            failureReason: null,
          };

    async function record(serviceId: string, kind: Kind) {
      const job = await newJob(serviceId);
      return recordCheckResult(p.prisma, {
        jobId: job.id,
        serviceId,
        configVersion: 1,
        outcome: outcome(kind),
        checkedAt: job.at,
      });
    }

    const one = async (sql: string, params: unknown[]) =>
      (await t.client.query(sql, params)).rows[0];
    const count = async (sql: string, params: unknown[]) =>
      (await one(`SELECT count(*)::int AS n FROM (${sql}) q`, params))
        .n as number;
    const incidents = (s: string) =>
      t.client
        .query(
          `SELECT id, status, origin, is_public, title FROM incidents WHERE service_id = $1 ORDER BY created_at`,
          [s],
        )
        .then((r) => r.rows);
    const statuses = (s: string) =>
      t.client
        .query(
          `SELECT status FROM service_status_history WHERE service_id = $1 ORDER BY started_at, id`,
          [s],
        )
        .then((r) => r.rows.map((x) => x.status));

    it("stores the result, closes the job, and brings a new service to Operational", async () => {
      const s = await newService();
      const job = await newJob(s);
      const recorded = await recordCheckResult(p.prisma, {
        jobId: job.id,
        serviceId: s,
        configVersion: 3,
        outcome: outcome("p"),
        checkedAt: job.at,
      });
      expect(recorded.stored).toBe(true);
      expect(recorded.change?.evaluation.displayed).toBe("Operational");
      const result = await one(
        `SELECT passed, latency_ms, config_version, checked_at FROM check_results WHERE job_id = $1`,
        [job.id],
      );
      expect(result).toMatchObject({
        passed: true,
        latency_ms: 120,
        config_version: 3,
        checked_at: job.at,
      });
      expect(
        await one(`SELECT status, lease_until FROM check_jobs WHERE id = $1`, [
          job.id,
        ]),
      ).toEqual({ status: "done", lease_until: null });
      expect(
        await one(
          `SELECT current_status, last_result_at FROM services WHERE id = $1`,
          [s],
        ),
      ).toEqual({ current_status: "Operational", last_result_at: job.at });
    });

    describe("a retried job (SP-03.3)", () => {
      it("creates no second result, no second transition and no second incident", async () => {
        const s = await newService();
        await record(s, "p");
        const job = await newJob(s);
        const input = {
          jobId: job.id,
          serviceId: s,
          configVersion: 1,
          outcome: outcome("f"),
          checkedAt: job.at,
        };
        const first = await recordCheckResult(p.prisma, input);
        const again = await recordCheckResult(p.prisma, input);
        expect(first.stored).toBe(true);
        expect(again).toEqual({
          stored: false,
          resultId: null,
          change: null,
          incidentId: null,
        });
        expect(
          await count(
            `SELECT 1 FROM check_results WHERE job_id = '${job.id}'`,
            [],
          ),
        ).toBe(1);
      });

      it("closes the job even when it only finds the earlier result", async () => {
        const s = await newService();
        const job = await newJob(s);
        const input = {
          jobId: job.id,
          serviceId: s,
          configVersion: 1,
          outcome: outcome("p"),
          checkedAt: job.at,
        };
        await recordCheckResult(p.prisma, input);
        await t.client.query(
          `UPDATE check_jobs SET status = 'leased' WHERE id = $1`,
          [job.id],
        );
        await recordCheckResult(p.prisma, input);
        expect(
          (await one(`SELECT status FROM check_jobs WHERE id = $1`, [job.id]))
            .status,
        ).toBe("done");
      });
    });

    describe("an outage opens one incident (SP-05.1, SP-05.2)", () => {
      it("opens exactly one automatic incident when the failure threshold is reached", async () => {
        const s = await newService();
        await record(s, "p");
        expect((await record(s, "f")).incidentId).toBeNull();
        expect((await record(s, "f")).incidentId).toBeNull();
        const third = await record(s, "f");
        expect(third.change?.evaluation.displayed).toBe("Outage");
        expect(third.incidentId).not.toBeNull();
        const [incident, ...rest] = await incidents(s);
        expect(rest).toEqual([]);
        expect(incident).toMatchObject({
          status: "Investigating",
          origin: "auto",
          is_public: false,
        });
        expect(incident.title).toContain("svc-");
      });

      it("opens nothing more while the outage continues", async () => {
        const s = await newService();
        await record(s, "p");
        for (let i = 0; i < 3; i++) await record(s, "f");
        for (let i = 0; i < 3; i++)
          expect((await record(s, "f")).incidentId).toBeNull();
        expect(await incidents(s)).toHaveLength(1);
        expect(await statuses(s)).toEqual(["Operational", "Outage"]);
      });

      it("makes the incident public only when its service is public (SP-05.5)", async () => {
        const publicService = await newService(true);
        const privateService = await newService(false);
        for (const s of [publicService, privateService]) {
          await record(s, "p");
          for (let i = 0; i < 3; i++) await record(s, "f");
        }
        expect((await incidents(publicService))[0].is_public).toBe(true);
        expect((await incidents(privateService))[0].is_public).toBe(false);
      });

      it("does not reopen after a responder resolves it while the service is still down", async () => {
        const s = await newService();
        await record(s, "p");
        for (let i = 0; i < 3; i++) await record(s, "f");
        await t.client.query(
          `UPDATE incidents SET status = 'Resolved', resolved_at = now(), resolved_by_user_id = $2 WHERE service_id = $1`,
          [s, userId],
        );
        expect((await record(s, "f")).incidentId).toBeNull();
        expect(await incidents(s)).toHaveLength(1);
      });

      it("opens a new incident for a later outage once the earlier one is resolved", async () => {
        const s = await newService();
        await record(s, "p");
        for (let i = 0; i < 3; i++) await record(s, "f");
        await t.client.query(
          `UPDATE incidents SET status = 'Resolved', resolved_at = now(), resolved_by_user_id = $2 WHERE service_id = $1`,
          [s, userId],
        );
        for (const kind of ["p", "p", "p", "p"] as Kind[])
          await record(s, kind); // Degraded, then Operational
        expect(
          (
            await t.client.query(
              `SELECT current_status FROM services WHERE id = $1`,
              [s],
            )
          ).rows[0].current_status,
        ).toBe("Operational");
        for (let i = 0; i < 3; i++) await record(s, "f");
        expect(await incidents(s)).toHaveLength(2);
      });
    });

    describe("overrides (SP-04.8)", () => {
      const setOverride = (s: string) =>
        t.client.query(
          `INSERT INTO status_overrides (service_id, status, reason, actor_user_id, expires_at) VALUES ($1, 'Operational', 'planned maintenance', $2, now() + interval '1 hour')`,
          [s, userId],
        );

      it("records the outage underneath but opens no incident while an override is active", async () => {
        const s = await newService();
        await record(s, "p");
        await setOverride(s);
        for (let i = 0; i < 3; i++) await record(s, "f");
        const row = await one(
          `SELECT current_status, computed_status FROM services WHERE id = $1`,
          [s],
        );
        expect(row).toEqual({
          current_status: "Operational",
          computed_status: "Outage",
        });
        expect(await incidents(s)).toHaveLength(0);
      });

      it("opens the incident when the override ends while the service is still down", async () => {
        const s = await newService();
        await record(s, "p");
        await setOverride(s);
        for (let i = 0; i < 3; i++) await record(s, "f");
        await t.client.query(
          `UPDATE status_overrides SET ended_at = now(), end_reason = 'cancelled', ended_by_user_id = $2 WHERE service_id = $1`,
          [s, userId],
        );
        const now = at(minute + 1);
        const incidentId = await p.prisma.$transaction(async (tx) => {
          const service = await lockService(tx, s);
          const change = await refreshStatus(tx, service!, now, { at: now });
          return openIncidentIfNeeded(tx, s, change);
        });
        expect(incidentId).not.toBeNull();
        expect(await incidents(s)).toHaveLength(1);
      });
    });

    describe("two workers at once", () => {
      it("record one Outage and one incident when both finish a failing check together", async () => {
        const s = await newService();
        await record(s, "p");
        await record(s, "f");
        await record(s, "f");
        const [a, b] = await Promise.all([record(s, "f"), record(s, "f")]);
        expect([a.incidentId, b.incidentId].filter(Boolean)).toHaveLength(1);
        expect(await incidents(s)).toHaveLength(1);
        expect(await statuses(s)).toEqual(["Operational", "Outage"]);
      });

      it("keep the result count right when many workers record for one service", async () => {
        const s = await newService();
        await record(s, "p");
        await Promise.all(Array.from({ length: 8 }, () => record(s, "p")));
        expect(
          await count(
            `SELECT 1 FROM check_results WHERE service_id = '${s}'`,
            [],
          ),
        ).toBe(9);
        expect(await statuses(s)).toEqual(["Operational"]);
      });
    });
  },
);
