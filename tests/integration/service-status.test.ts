import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  lockService,
  refreshServiceStatus,
  type Cause,
} from "../../src/db/service-status";
import {
  createTestDb,
  hasTestDb,
  prismaFor,
  type TestDb,
} from "../helpers/test-db";

const T0 = new Date("2026-10-11T12:00:00Z").getTime();
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasTestDb)(
  "service status writer and row lock (SP-04)",
  () => {
    let t: TestDb;
    let p: ReturnType<typeof prismaFor>;
    let userId: string;
    let projectId: string;
    let n = 0;
    let minute = 0; // each result gets its own minute, so scheduled_for is unique per service

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

    // fail 3, recovery 2, slow 3, latency limit 1000 ms, 60 s interval
    async function newService(): Promise<string> {
      n += 1;
      return (
        await t.client.query(
          `INSERT INTO services (project_id, name, url, interval_seconds, timeout_seconds, fail_threshold, recovery_threshold, slow_threshold, degraded_ms, status_since, computed_since)
         VALUES ($1, $2, 'https://example.com', 60, 5, 3, 2, 3, 1000, $3, $3) RETURNING id`,
          [projectId, `svc-${n}`, at(-24 * 60)], // the service existed before the first result of the test timeline
        )
      ).rows[0].id;
    }

    /** Records a result the way the worker will: job, result and last_result_at together. Returns its id and time. */
    async function addResult(
      serviceId: string,
      kind: "p" | "s" | "f",
    ): Promise<{ id: string; at: Date }> {
      minute += 1;
      const when = at(minute);
      const job = (
        await t.client.query(
          `INSERT INTO check_jobs (service_id, scheduled_for, status) VALUES ($1, $2, 'done') RETURNING id`,
          [serviceId, when],
        )
      ).rows[0].id;
      const id = (
        await t.client.query(
          `INSERT INTO check_results (job_id, service_id, status_code, latency_ms, passed, config_version, checked_at)
         VALUES ($1, $2, $3, $4, $5, 1, $6) RETURNING id`,
          [
            job,
            serviceId,
            kind === "f" ? 500 : 200,
            kind === "f" ? null : kind === "s" ? 2500 : 120,
            kind !== "f",
            when,
          ],
        )
      ).rows[0].id;
      await t.client.query(
        `UPDATE services SET last_result_at = $2 WHERE id = $1`,
        [serviceId, when],
      );
      return { id, at: when };
    }

    /** What the worker does after saving a result: refresh at the result's own time. */
    async function record(serviceId: string, kind: "p" | "s" | "f") {
      const r = await addResult(serviceId, kind);
      return refreshServiceStatus(p.prisma, serviceId, r.at, {
        at: r.at,
        resultId: r.id,
      });
    }
    const row = async (id: string) =>
      (
        await t.client.query(
          `SELECT current_status, computed_status, status_since, computed_since FROM services WHERE id = $1`,
          [id],
        )
      ).rows[0];
    const history = async (id: string) =>
      (
        await t.client.query(
          `SELECT status, computed_status, source, caused_by_result_id FROM service_status_history WHERE service_id = $1 ORDER BY started_at, id`,
          [id],
        )
      ).rows;

    describe("recording transitions", () => {
      it("moves Unknown to Operational on the first passing result and records why", async () => {
        const s = await newService();
        const r = await addResult(s, "p");
        const change = await refreshServiceStatus(p.prisma, s, r.at, {
          at: r.at,
          resultId: r.id,
        });
        expect(change?.evaluation.displayed).toBe("Operational");
        expect(change?.previousDisplayed).toBe("Unknown");
        const current = await row(s);
        expect(current.current_status).toBe("Operational");
        expect(current.computed_status).toBe("Operational");
        expect(current.computed_since).toEqual(r.at);
        expect(await history(s)).toEqual([
          {
            status: "Operational",
            computed_status: "Operational",
            source: "computed",
            caused_by_result_id: r.id,
          },
        ]);
      });

      it("writes nothing when nothing changed", async () => {
        const s = await newService();
        await record(s, "p");
        const before = await row(s);
        const change = await record(s, "p");
        expect(change?.displayedChanged).toBe(false);
        expect(change?.computedChanged).toBe(false);
        expect(await row(s)).toEqual(before);
        expect(await history(s)).toHaveLength(1);
      });

      it("turns three failures into exactly one Outage and no more history after that", async () => {
        const s = await newService();
        await record(s, "p");
        expect((await record(s, "f"))?.displayedChanged).toBe(false);
        expect((await record(s, "f"))?.displayedChanged).toBe(false);
        const third = await record(s, "f");
        expect(third?.evaluation.displayed).toBe("Outage");
        await record(s, "f");
        await record(s, "f");
        expect((await history(s)).map((h) => h.status)).toEqual([
          "Operational",
          "Outage",
        ]);
      });

      it("recovers in two earned steps, counting only results after each transition", async () => {
        const s = await newService();
        await record(s, "p");
        for (let i = 0; i < 3; i++) await record(s, "f"); // Outage
        await record(s, "s"); // one slow success right after the failures: the service was waking
        expect((await row(s)).current_status).toBe("Outage");
        await record(s, "p"); // second recovery pass, now Degraded
        expect((await row(s)).current_status).toBe("Degraded");
        await record(s, "p"); // one fast pass is not enough for the second step
        expect((await row(s)).current_status).toBe("Degraded");
        await record(s, "p");
        expect((await row(s)).current_status).toBe("Operational");
        expect((await history(s)).map((h) => h.status)).toEqual([
          "Operational",
          "Outage",
          "Degraded",
          "Operational",
        ]);
      });

      it("does not let a second slow result count toward recovery", async () => {
        const s = await newService();
        await record(s, "p");
        for (let i = 0; i < 3; i++) await record(s, "f");
        await record(s, "s");
        await record(s, "s"); // does not count and restarts the streak
        expect((await row(s)).current_status).toBe("Outage");
        await record(s, "p");
        expect((await row(s)).current_status).toBe("Outage");
        await record(s, "p");
        expect((await row(s)).current_status).toBe("Degraded");
      });
    });

    describe("stale, disabled and restarted streaks (SP-04.6, SP-04.7, SP-02.9)", () => {
      it("goes Unknown after three intervals without a result, and says so", async () => {
        const s = await newService();
        const r = await addResult(s, "p");
        await refreshServiceStatus(p.prisma, s, r.at, {
          at: r.at,
          resultId: r.id,
        });
        const later = new Date(r.at.getTime() + 3 * 60_000 + 1);
        const change = await refreshServiceStatus(p.prisma, s, later, {
          at: later,
        });
        expect(change?.evaluation.displayed).toBe("Unknown");
        expect((await history(s)).at(-1)).toMatchObject({
          status: "Unknown",
          source: "stale",
          caused_by_result_id: null,
        });
        expect((await row(s)).computed_since).toEqual(later);
      });

      it("is idempotent: sweeping a stale service again records nothing", async () => {
        const s = await newService();
        const r = await addResult(s, "p");
        await refreshServiceStatus(p.prisma, s, r.at, {
          at: r.at,
          resultId: r.id,
        });
        const later = new Date(r.at.getTime() + 10 * 60_000);
        await refreshServiceStatus(p.prisma, s, later, { at: later });
        const again = await refreshServiceStatus(
          p.prisma,
          s,
          new Date(later.getTime() + 60_000),
          { at: new Date(later.getTime() + 60_000) },
        );
        expect(again?.displayedChanged).toBe(false);
        expect(
          (await history(s)).filter((h) => h.source === "stale"),
        ).toHaveLength(1);
      });

      it("restarts streaks after Unknown: earlier failures no longer count", async () => {
        const s = await newService();
        await record(s, "p");
        await record(s, "f");
        await record(s, "f"); // two failures, one short of Outage
        const gap = new Date(at(minute).getTime() + 4 * 60_000);
        await refreshServiceStatus(p.prisma, s, gap, { at: gap }); // stale: Unknown
        expect((await row(s)).current_status).toBe("Unknown");
        minute += 10;
        const r = await addResult(s, "f"); // the third failure overall, but only the first since Unknown
        await refreshServiceStatus(p.prisma, s, r.at, {
          at: r.at,
          resultId: r.id,
        });
        expect((await row(s)).current_status).toBe("Unknown");
      });

      it("shows Unknown when the service is disabled", async () => {
        const s = await newService();
        await record(s, "p");
        await t.client.query(
          `UPDATE services SET enabled = false WHERE id = $1`,
          [s],
        );
        const now = at(minute + 1);
        const change = await refreshServiceStatus(p.prisma, s, now, {
          at: now,
        });
        expect(change?.evaluation.displayed).toBe("Unknown");
        expect((await history(s)).at(-1)).toMatchObject({
          status: "Unknown",
          source: "disabled",
        });
      });

      it("returns null for a service that does not exist or was deleted", async () => {
        expect(
          await refreshServiceStatus(
            p.prisma,
            "00000000-0000-0000-0000-000000000000",
            at(1),
            { at: at(1) },
          ),
        ).toBeNull();
        const s = await newService();
        await t.client.query(
          `UPDATE services SET deleted_at = now() WHERE id = $1`,
          [s],
        );
        expect(
          await refreshServiceStatus(p.prisma, s, at(1), { at: at(1) }),
        ).toBeNull();
      });
    });

    describe("overrides (SP-04.5, SP-04.8)", () => {
      const setOverride = (s: string) =>
        t.client.query(
          `INSERT INTO status_overrides (service_id, status, reason, actor_user_id, expires_at) VALUES ($1, 'Operational', 'planned maintenance', $2, now() + interval '1 hour')`,
          [s, userId],
        );

      it("shows the override while the computed status keeps following the results", async () => {
        const s = await newService();
        await record(s, "p");
        await setOverride(s);
        for (let i = 0; i < 3; i++) await record(s, "f");
        const current = await row(s);
        expect(current.current_status).toBe("Operational"); // shown
        expect(current.computed_status).toBe("Outage"); // underneath
        expect((await history(s)).at(-1)).toMatchObject({
          status: "Operational",
          computed_status: "Outage",
          source: "override",
        });
      });

      it("resumes the computed status when the override ends", async () => {
        const s = await newService();
        await record(s, "p");
        await setOverride(s);
        for (let i = 0; i < 3; i++) await record(s, "f");
        await t.client.query(
          `UPDATE status_overrides SET ended_at = now(), end_reason = 'cancelled', ended_by_user_id = $2 WHERE service_id = $1`,
          [s, userId],
        );
        const now = at(minute + 1);
        const change = await refreshServiceStatus(p.prisma, s, now, {
          at: now,
        });
        expect(change?.previousDisplayed).toBe("Operational");
        expect(change?.evaluation.displayed).toBe("Outage");
        expect(change?.computedChanged).toBe(false);
        expect((await row(s)).current_status).toBe("Outage");
      });
    });

    describe("the row lock", () => {
      it("makes a second transaction on the same service wait until the first commits", async () => {
        const s = await newService();
        const events: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));

        const first = p.prisma.$transaction(async (tx) => {
          await lockService(tx, s);
          events.push("first locked");
          await gate;
          events.push("first committing");
        });
        while (!events.includes("first locked")) await sleep(10);

        const second = p.prisma.$transaction(async (tx) => {
          await lockService(tx, s);
          events.push("second locked");
        });
        await sleep(400);
        expect(events).toEqual(["first locked"]); // the second is still waiting
        release();
        await Promise.all([first, second]);
        expect(events).toEqual([
          "first locked",
          "first committing",
          "second locked",
        ]);
      });

      it("does not block a different service", async () => {
        const a = await newService();
        const b = await newService();
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        let aLocked = false;
        const holder = p.prisma.$transaction(async (tx) => {
          await lockService(tx, a);
          aLocked = true;
          await gate;
        });
        while (!aLocked) await sleep(10);
        const other = await p.prisma.$transaction((tx) => lockService(tx, b));
        expect(other?.id).toBe(b);
        release();
        await holder;
      });

      it("lets two simultaneous refreshes record a transition only once", async () => {
        const s = await newService();
        await record(s, "p");
        for (let i = 0; i < 2; i++) await addResult(s, "f");
        const last = await addResult(s, "f"); // the third failure is in the table, no refresh has run yet
        const cause: Cause = { at: last.at, resultId: last.id };
        const [x, y] = await Promise.all([
          refreshServiceStatus(p.prisma, s, last.at, cause),
          refreshServiceStatus(p.prisma, s, last.at, cause),
        ]);
        expect(
          [x?.displayedChanged, y?.displayedChanged].filter(Boolean),
        ).toHaveLength(1);
        expect(
          (await history(s)).filter((h) => h.status === "Outage"),
        ).toHaveLength(1);
      });
    });
  },
);
