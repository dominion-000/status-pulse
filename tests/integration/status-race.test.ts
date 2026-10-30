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

// An owner sets an override at the same moment a worker records the check that crosses the failure threshold.
// Both orders are legitimate, so the test checks what must hold either way, over many interleavings.
describe.skipIf(!hasTestDb)(
  "an override and a check result at the same moment (SP-04.5, SP-04.8)",
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
    });
    afterAll(async () => {
      await p?.close();
      await t?.close();
    });

    async function newService(): Promise<string> {
      n += 1;
      return (
        await t.client.query(
          `INSERT INTO services (project_id, name, url, interval_seconds, timeout_seconds, fail_threshold, recovery_threshold, slow_threshold, degraded_ms, status_since, computed_since)
         VALUES ($1, $2, 'https://example.com', 60, 5, 3, 2, 3, 1000, $3, $3) RETURNING id`,
          [projectId, `svc-${n}`, at(-24 * 60)],
        )
      ).rows[0].id;
    }

    async function record(serviceId: string, passed: boolean) {
      minute += 1;
      const when = at(minute);
      const job = (
        await t.client.query(
          `INSERT INTO check_jobs (service_id, scheduled_for, status, attempts) VALUES ($1, $2, 'leased', 1) RETURNING id`,
          [serviceId, when],
        )
      ).rows[0].id;
      return recordCheckResult(p.prisma, {
        jobId: job,
        serviceId,
        configVersion: 1,
        outcome: passed
          ? {
              statusCode: 200,
              latencyMs: 100,
              passed: true,
              failureReason: null,
            }
          : {
              statusCode: 500,
              latencyMs: 40,
              passed: false,
              failureReason: "status 500",
            },
        checkedAt: when,
      });
    }

    // What the override endpoint will do: lock, add the override, recalculate, and open an incident if one is called for.
    async function setOverride(serviceId: string) {
      const now = at(minute + 1);
      return p.prisma.$transaction(async (tx) => {
        const service = await lockService(tx, serviceId);
        await tx.$executeRaw`
        INSERT INTO status_overrides (service_id, status, reason, actor_user_id, expires_at)
        VALUES (${serviceId}::uuid, 'Operational', 'planned maintenance', ${userId}::uuid, now() + interval '1 hour')`;
        const change = await refreshStatus(tx, service!, now, { at: now });
        return openIncidentIfNeeded(tx, serviceId, change);
      });
    }

    it("leaves a consistent outcome whichever of the two happens first", async () => {
      for (let round = 0; round < 15; round++) {
        const s = await newService();
        await record(s, true);
        await record(s, false);
        await record(s, false); // one failure short of Outage

        await Promise.all([record(s, false), setOverride(s)]);

        const service = (
          await t.client.query(
            `SELECT current_status, computed_status FROM services WHERE id = $1`,
            [s],
          )
        ).rows[0];
        const incidents = (
          await t.client.query(
            `SELECT count(*)::int AS n FROM incidents WHERE service_id = $1`,
            [s],
          )
        ).rows[0].n;
        const shownOutage = (
          await t.client.query(
            `SELECT count(*)::int AS n FROM service_status_history WHERE service_id = $1 AND status = 'Outage'`,
            [s],
          )
        ).rows[0].n;

        // the override is active, so Operational is shown, while the results underneath say Outage
        expect(service, `round ${round}`).toEqual({
          current_status: "Operational",
          computed_status: "Outage",
        });
        // Outage was shown if and only if an incident was opened for it, and never more than once
        expect(incidents, `round ${round}`).toBeLessThanOrEqual(1);
        expect(shownOutage, `round ${round}`).toBe(incidents);
      }
    }, 60_000);
  },
);
