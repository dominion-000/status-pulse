import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { claimJob, skipStaleJobs } from "../../src/db/jobs";
import * as statusModule from "../../src/db/service-status";
import { sweepStatus } from "../../src/db/sweeper";
import {
  createTestDb,
  hasTestDb,
  prismaFor,
  type TestDb,
} from "../helpers/test-db";

vi.mock("../../src/db/service-status", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/db/service-status")>();
  return { ...actual, refreshStatus: vi.fn(actual.refreshStatus) };
});

const T0 = new Date("2026-10-11T12:00:00Z").getTime();
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

describe.skipIf(!hasTestDb)(
  "the status sweeper and stale jobs (SP-04.5, SP-04.6, SP-03.7, SP-08.3)",
  () => {
    let t: TestDb;
    let p: ReturnType<typeof prismaFor>;
    let userId: string;
    let projectId: string;
    let n = 0;

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
    });
    afterAll(async () => {
      await p?.close();
      await t?.close();
    });

    interface Options {
      current?: string;
      computed?: string;
      enabled?: boolean;
      lastResultAt?: Date | null;
    }
    // 60 s interval; the service existed long before the test timeline
    async function newService(o: Options = {}): Promise<string> {
      n += 1;
      return (
        await t.client.query(
          `INSERT INTO services (project_id, name, url, interval_seconds, timeout_seconds, current_status, computed_status, enabled, last_result_at, status_since, computed_since)
         VALUES ($1, $2, 'https://example.com', 60, 5, $3, $4, $5, $6, $7, $7) RETURNING id`,
          [
            projectId,
            `svc-${n}`,
            o.current ?? "Operational",
            o.computed ?? o.current ?? "Operational",
            o.enabled ?? true,
            o.lastResultAt === undefined ? at(0) : o.lastResultAt,
            at(-24 * 60),
          ],
        )
      ).rows[0].id;
    }
    const row = async (id: string) =>
      (
        await t.client.query(
          `SELECT current_status, computed_status FROM services WHERE id = $1`,
          [id],
        )
      ).rows[0];
    const history = async (id: string) =>
      (
        await t.client.query(
          `SELECT status, source FROM service_status_history WHERE service_id = $1 ORDER BY started_at`,
          [id],
        )
      ).rows;
    const afterIntervals = (
      lastResult: number,
      intervals: number,
      extraMs = 0,
    ) => new Date(at(lastResult).getTime() + intervals * 60_000 + extraMs);

    describe("stale results (SP-04.6)", () => {
      it("sets a service to Unknown when it has had no result for more than three intervals", async () => {
        const s = await newService({ lastResultAt: at(0) });
        const result = await sweepStatus(p.prisma, afterIntervals(0, 3, 1000));
        expect(result.statusChanges).toBeGreaterThanOrEqual(1);
        expect(await row(s)).toEqual({
          current_status: "Unknown",
          computed_status: "Unknown",
        });
        expect(await history(s)).toEqual([
          { status: "Unknown", source: "stale" },
        ]);
      });

      it("leaves a service alone at exactly three intervals", async () => {
        const s = await newService({ lastResultAt: at(0) });
        await sweepStatus(p.prisma, afterIntervals(0, 3));
        expect((await row(s)).current_status).toBe("Operational");
        expect(await history(s)).toEqual([]);
      });

      it("does nothing the second time: a sweep is idempotent", async () => {
        const s = await newService({ lastResultAt: at(0) });
        const now = afterIntervals(0, 10);
        await sweepStatus(p.prisma, now);
        const again = await sweepStatus(
          p.prisma,
          new Date(now.getTime() + 5000),
        );
        expect(again.statusChanges).toBe(0);
        expect(await history(s)).toHaveLength(1);
      });

      it("treats a service that never had a result as stale, and an Unknown one as already done", async () => {
        const neverChecked = await newService({
          current: "Operational",
          lastResultAt: null,
        });
        const alreadyUnknown = await newService({
          current: "Unknown",
          lastResultAt: null,
        });
        await sweepStatus(p.prisma, at(5));
        expect((await row(neverChecked)).current_status).toBe("Unknown");
        expect(await history(alreadyUnknown)).toEqual([]);
      });

      it("opens no incident for a stale service, even one that was in Outage", async () => {
        const s = await newService({ current: "Outage", lastResultAt: at(0) });
        const result = await sweepStatus(p.prisma, afterIntervals(0, 4));
        expect(result.incidentsOpened).toBe(0);
        expect((await row(s)).current_status).toBe("Unknown");
        expect(
          (
            await t.client.query(
              `SELECT 1 FROM incidents WHERE service_id = $1`,
              [s],
            )
          ).rowCount,
        ).toBe(0);
      });
    });

    describe("disabled services (SP-02.9)", () => {
      it("shows Unknown for a service that was disabled", async () => {
        const s = await newService({
          enabled: false,
          current: "Operational",
          lastResultAt: at(0),
        });
        await sweepStatus(p.prisma, at(1));
        expect(await row(s)).toEqual({
          current_status: "Unknown",
          computed_status: "Unknown",
        });
        expect(await history(s)).toEqual([
          { status: "Unknown", source: "disabled" },
        ]);
      });
    });

    describe("override expiry (SP-04.5)", () => {
      const insertOverride = (
        s: string,
        createdMin: number,
        expiresMin: number,
      ) =>
        t.client.query(
          `INSERT INTO status_overrides (service_id, status, reason, actor_user_id, created_at, expires_at) VALUES ($1, 'Operational', 'planned maintenance', $2, $3, $4)`,
          [s, userId, at(createdMin), at(expiresMin)],
        );

      it("ends an expired override, shows the real status again, and opens the incident if it is down", async () => {
        // shown Operational because of the override; underneath the service has been in Outage
        const s = await newService({
          current: "Operational",
          computed: "Outage",
          lastResultAt: at(-1),
        });
        await insertOverride(s, -60, -30);
        const result = await sweepStatus(p.prisma, at(0));
        expect(result.overridesEnded).toBe(1);
        expect(result.incidentsOpened).toBe(1);
        expect((await row(s)).current_status).toBe("Outage");
        const ended = (
          await t.client.query(
            `SELECT ended_at, end_reason FROM status_overrides WHERE service_id = $1`,
            [s],
          )
        ).rows[0];
        expect(ended).toEqual({ ended_at: at(-30), end_reason: "expired" }); // ended at its expiry, not when it was noticed
        expect((await history(s)).at(-1)).toEqual({
          status: "Outage",
          source: "computed",
        });
      });

      it("leaves an override that has not expired yet", async () => {
        const s = await newService({
          current: "Operational",
          computed: "Outage",
          lastResultAt: at(-1),
        });
        await insertOverride(s, -60, 30);
        const result = await sweepStatus(p.prisma, at(0));
        expect(result.overridesEnded).toBe(0);
        expect((await row(s)).current_status).toBe("Operational");
        expect(
          (
            await t.client.query(
              `SELECT 1 FROM incidents WHERE service_id = $1`,
              [s],
            )
          ).rowCount,
        ).toBe(0);
      });

      it("lets a new override be set once the old one was swept", async () => {
        const s = await newService({
          current: "Operational",
          computed: "Operational",
          lastResultAt: at(-1),
        });
        await insertOverride(s, -60, -30);
        await sweepStatus(p.prisma, at(0));
        await expect(insertOverride(s, -10, 60)).resolves.toBeDefined();
      });
    });

    describe("one failing service does not stop the others", () => {
      it("records the failure and still updates the rest", async () => {
        const bad = await newService({ lastResultAt: at(0) });
        const good = await newService({ lastResultAt: at(0) });
        const actual = await vi.importActual<
          typeof import("../../src/db/service-status")
        >("../../src/db/service-status");
        vi.mocked(statusModule.refreshStatus).mockImplementation(
          async (tx, service, now, cause) => {
            if (service.id === bad) throw new Error("boom");
            return actual.refreshStatus(tx, service, now, cause);
          },
        );
        try {
          const result = await sweepStatus(p.prisma, afterIntervals(0, 5));
          expect(result.failures).toBeGreaterThanOrEqual(1);
        } finally {
          vi.mocked(statusModule.refreshStatus).mockImplementation(
            actual.refreshStatus,
          );
        }
        expect((await row(good)).current_status).toBe("Unknown");
        expect((await row(bad)).current_status).toBe("Operational"); // rolled back, will be retried on the next sweep
        const failure = (
          await t.client.query(
            `SELECT message, details FROM scheduler_failures WHERE details->>'serviceId' = $1`,
            [bad],
          )
        ).rows[0];
        expect(failure.message).toBe("status sweep failed");
        expect(failure.details.error).toBe("boom");
      });
    });

    describe("after downtime: no catch-up (SP-03.7)", () => {
      it("claims only the current job and skips the twenty missed ones", async () => {
        const s = await newService();
        const now = new Date(at(60).getTime() + 5000); // five seconds into the current slot
        for (let k = 1; k <= 20; k++) {
          await t.client.query(
            `INSERT INTO check_jobs (service_id, scheduled_for) VALUES ($1, $2)`,
            [s, at(60 - k)],
          );
        }
        await t.client.query(
          `INSERT INTO check_jobs (service_id, scheduled_for) VALUES ($1, $2)`,
          [s, at(60)],
        );

        const job = await claimJob(p.pool, now, 60, 5);
        expect(job?.scheduled_for).toEqual(at(60));
        expect(await claimJob(p.pool, now, 60, 5)).toBeNull(); // nothing else is claimable: one check runs

        expect(await skipStaleJobs(p.pool, now)).toBe(20);
        const counts = (
          await t.client.query(
            `SELECT status, count(*)::int AS n FROM check_jobs WHERE service_id = $1 GROUP BY status ORDER BY status`,
            [s],
          )
        ).rows;
        expect(counts).toEqual([
          { status: "leased", n: 1 },
          { status: "skipped", n: 20 },
        ]);
      });
    });
  },
);
