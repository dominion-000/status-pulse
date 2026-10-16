import { randomBytes } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { signAccessToken } from "../../src/auth/tokens";
import { loadConfig } from "../../src/config";
import { recordCheckResult } from "../../src/db/record-result";
import {
  createTestDb,
  hasTestDb,
  prismaFor,
  type TestDb,
} from "../helpers/test-db";

const SECRET = "s".repeat(40);
const hour = 3_600_000;
const iso = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString();

describe.skipIf(!hasTestDb)(
  "status, override, disable and enable endpoints (SP-04, SP-02.9)",
  () => {
    let t: TestDb;
    let p: ReturnType<typeof prismaFor>;
    let app: ReturnType<typeof createApp>;
    let projectId: string;
    let otherProjectId: string;
    let ids: Record<"owner" | "responder" | "viewer" | "outsider", string>;
    let token: Record<"owner" | "responder" | "viewer" | "outsider", string>;
    let n = 0;

    beforeAll(async () => {
      t = await createTestDb();
      p = prismaFor(t);
      const config = loadConfig({
        DATABASE_URL: "postgres://unused",
        CREDENTIALS_ENC_KEY: randomBytes(32).toString("base64"),
        JWT_SECRET: SECRET,
      } as NodeJS.ProcessEnv);
      app = createApp({
        config,
        prisma: p.prisma,
        logStream: { write: () => {} },
      });

      const user = async (email: string) =>
        (
          await t.client.query(
            `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
            [email],
          )
        ).rows[0].id as string;
      ids = {
        owner: await user("owner@x.io"),
        responder: await user("responder@x.io"),
        viewer: await user("viewer@x.io"),
        outsider: await user("outsider@x.io"),
      };
      token = Object.fromEntries(
        Object.entries(ids).map(([k, id]) => [
          k,
          signAccessToken(id, SECRET, 900),
        ]),
      ) as typeof token;
      projectId = (
        await t.client.query(
          `INSERT INTO projects (name, slug) VALUES ('p', 'p') RETURNING id`,
        )
      ).rows[0].id;
      await t.client.query(
        `UPDATE projects SET plan_id = (SELECT id FROM plans WHERE name = 'pro') WHERE id = $1`,
        [projectId],
      );

      otherProjectId = (
        await t.client.query(
          `INSERT INTO projects (name, slug) VALUES ('q', 'q') RETURNING id`,
        )
      ).rows[0].id;
      for (const [who, role] of [
        ["owner", "Owner"],
        ["responder", "Responder"],
        ["viewer", "Viewer"],
      ] as const) {
        await t.client.query(
          `INSERT INTO memberships (project_id, user_id, role) VALUES ($1, $2, $3)`,
          [projectId, ids[who], role],
        );
      }
    });
    afterAll(async () => {
      await p?.close();
      await t?.close();
    });

    interface Options {
      current?: string;
      computed?: string;
      enabled?: boolean;
      project?: string;
    }
    async function newService(o: Options = {}): Promise<string> {
      n += 1;
      const old = new Date(Date.now() - 24 * hour);
      return (
        await t.client.query(
          `INSERT INTO services (project_id, name, url, interval_seconds, timeout_seconds, fail_threshold, recovery_threshold, slow_threshold, degraded_ms,
                               current_status, computed_status, enabled, last_result_at, status_since, computed_since)
         VALUES ($1, $2, 'https://example.com', 60, 5, 3, 2, 3, 1000, $3, $4, $5, now(), $6, $6) RETURNING id`,
          [
            o.project ?? projectId,
            `svc-${n}`,
            o.current ?? "Operational",
            o.computed ?? o.current ?? "Operational",
            o.enabled ?? true,
            old,
          ],
        )
      ).rows[0].id;
    }
    const base = (s: string, projectOverride?: string) =>
      `/api/v1/projects/${projectOverride ?? projectId}/services/${s}`;
    const as = (who: keyof typeof token) => ({
      Authorization: `Bearer ${who === "owner" ? token.owner : token[who]}`,
    });
    const row = async (s: string) =>
      (
        await t.client.query(
          `SELECT current_status, computed_status, enabled FROM services WHERE id = $1`,
          [s],
        )
      ).rows[0];
    const audit = async (s: string, action: string) =>
      (
        await t.client.query(
          `SELECT actor_user_id, details FROM audit_log WHERE entity_id = $1 AND action = $2`,
          [s, action],
        )
      ).rows;
    const override = {
      status: "Operational",
      reason: "planned maintenance",
      expiresAt: "",
    };
    const withExpiry = (ms = hour) => ({ ...override, expiresAt: iso(ms) });

    describe("GET status", () => {
      it("shows members what is shown, what is underneath, and the active override", async () => {
        const s = await newService({
          current: "Operational",
          computed: "Outage",
        });
        await t.client.query(
          `INSERT INTO status_overrides (service_id, status, reason, actor_user_id, expires_at) VALUES ($1, 'Operational', 'maintenance', $2, now() + interval '1 hour')`,
          [s, ids.owner],
        );
        const res = await request(app)
          .get(`${base(s)}/status`)
          .set(as("viewer"));
        expect(res.status).toBe(200);
        expect(res.body.status).toMatchObject({
          current: "Operational",
          computed: "Outage",
          override: { status: "Operational", reason: "maintenance" },
        });
        expect(typeof res.body.status.since).toBe("string");
      });

      it("refuses outsiders and anonymous callers, and hides services of other projects", async () => {
        const s = await newService();
        expect(
          (
            await request(app)
              .get(`${base(s)}/status`)
              .set(as("outsider"))
          ).status,
        ).toBe(404);
        expect((await request(app).get(`${base(s)}/status`)).status).toBe(401);
        const foreign = await newService({ project: otherProjectId });
        expect(
          (
            await request(app)
              .get(`${base(foreign)}/status`)
              .set(as("owner"))
          ).status,
        ).toBe(404);
        expect(
          (
            await request(app)
              .get(`/api/v1/projects/${projectId}/services/${foreign}/status`)
              .set(as("owner"))
          ).status,
        ).toBe(404);
      });
    });

    describe("GET status history", () => {
      it("lists transitions newest first and honours the limit", async () => {
        const s = await newService();
        for (const [status, minutesAgo] of [
          ["Outage", 30],
          ["Degraded", 20],
          ["Operational", 10],
        ] as const) {
          await t.client.query(
            `INSERT INTO service_status_history (service_id, status, computed_status, source, started_at) VALUES ($1, $2, $2, 'computed', now() - $3 * interval '1 minute')`,
            [s, status, minutesAgo],
          );
        }
        const all = await request(app)
          .get(`${base(s)}/status/history`)
          .set(as("viewer"));
        expect(
          all.body.history.map((h: { status: string }) => h.status),
        ).toEqual(["Operational", "Degraded", "Outage"]);
        const two = await request(app)
          .get(`${base(s)}/status/history?limit=2`)
          .set(as("viewer"));
        expect(two.body.history).toHaveLength(2);
        expect(
          (
            await request(app)
              .get(`${base(s)}/status/history`)
              .set(as("outsider"))
          ).status,
        ).toBe(404);
      });
    });

    describe("POST override (SP-04.5)", () => {
      it("lets an owner set one: it is shown, the results stay underneath, and who did it is audited", async () => {
        const s = await newService({ current: "Outage", computed: "Outage" });
        const res = await request(app)
          .post(`${base(s)}/override`)
          .set(as("owner"))
          .send(withExpiry());
        expect(res.status).toBe(201);
        expect(res.body.status).toMatchObject({
          current: "Operational",
          computed: "Outage",
        });
        expect(res.body.status.override).toMatchObject({
          status: "Operational",
          reason: "planned maintenance",
        });
        const [entry] = await audit(s, "status.override_set");
        expect(entry.actor_user_id).toBe(ids.owner);
        expect(entry.details).toMatchObject({
          status: "Operational",
          reason: "planned maintenance",
        });
      });

      it("refuses anyone below Owner, outsiders, and anonymous callers", async () => {
        const s = await newService();
        expect(
          (
            await request(app)
              .post(`${base(s)}/override`)
              .set(as("responder"))
              .send(withExpiry())
          ).status,
        ).toBe(403);
        expect(
          (
            await request(app)
              .post(`${base(s)}/override`)
              .set(as("viewer"))
              .send(withExpiry())
          ).status,
        ).toBe(403);
        expect(
          (
            await request(app)
              .post(`${base(s)}/override`)
              .set(as("outsider"))
              .send(withExpiry())
          ).status,
        ).toBe(404);
        expect(
          (
            await request(app)
              .post(`${base(s)}/override`)
              .send(withExpiry())
          ).status,
        ).toBe(401);
      });

      it.each([
        ["a reason that is too short", { reason: "ok" }, "reason"],
        [
          "an expiry in the past",
          { expiresAt: new Date(Date.now() - hour).toISOString() },
          "expiresAt",
        ],
        [
          "an expiry more than 30 days away",
          { expiresAt: new Date(Date.now() + 31 * 24 * hour).toISOString() },
          "expiresAt",
        ],
        ["an unknown status", { status: "Fine" }, "status"],
        ["no expiry", { expiresAt: undefined }, "expiresAt"],
      ])(
        "rejects %s with a 422 naming the field",
        async (_label, patch, field) => {
          const s = await newService();
          const res = await request(app)
            .post(`${base(s)}/override`)
            .set(as("owner"))
            .send({ ...withExpiry(), ...patch });
          expect(res.status).toBe(422);
          expect(res.body.error.code).toBe("VALIDATION");
          expect(
            res.body.error.details.map((d: { path: string }) => d.path),
          ).toContain(field);
        },
      );

      it("refuses a second override while one is active", async () => {
        const s = await newService();
        expect(
          (
            await request(app)
              .post(`${base(s)}/override`)
              .set(as("owner"))
              .send(withExpiry())
          ).status,
        ).toBe(201);
        expect(
          (
            await request(app)
              .post(`${base(s)}/override`)
              .set(as("owner"))
              .send(withExpiry())
          ).status,
        ).toBe(409);
      });

      it("is not blocked by an override that expired but has not been swept yet", async () => {
        const s = await newService();
        await t.client.query(
          `INSERT INTO status_overrides (service_id, status, reason, actor_user_id, created_at, expires_at) VALUES ($1, 'Operational', 'old', $2, now() - interval '2 hours', now() - interval '1 hour')`,
          [s, ids.owner],
        );
        expect(
          (
            await request(app)
              .post(`${base(s)}/override`)
              .set(as("owner"))
              .send(withExpiry())
          ).status,
        ).toBe(201);
        const old = (
          await t.client.query(
            `SELECT end_reason, ended_at, expires_at FROM status_overrides WHERE service_id = $1 AND reason = 'old'`,
            [s],
          )
        ).rows[0];
        expect(old.end_reason).toBe("expired");
        expect(old.ended_at).toEqual(old.expires_at);
      });

      it("refuses an override on a disabled service", async () => {
        const s = await newService({
          enabled: false,
          current: "Unknown",
          computed: "Unknown",
        });
        expect(
          (
            await request(app)
              .post(`${base(s)}/override`)
              .set(as("owner"))
              .send(withExpiry())
          ).status,
        ).toBe(409);
      });
    });

    describe("DELETE override", () => {
      it("cancels it, shows the real status again, opens the incident when the service is down, and audits it", async () => {
        const s = await newService({
          current: "Operational",
          computed: "Outage",
        });
        await t.client.query(
          `INSERT INTO status_overrides (service_id, status, reason, actor_user_id, expires_at) VALUES ($1, 'Operational', 'maintenance', $2, now() + interval '1 hour')`,
          [s, ids.owner],
        );
        const res = await request(app)
          .delete(`${base(s)}/override`)
          .set(as("owner"));
        expect(res.status).toBe(200);
        expect(res.body.status).toMatchObject({
          current: "Outage",
          override: null,
        });
        expect(
          (
            await t.client.query(
              `SELECT origin, status FROM incidents WHERE service_id = $1`,
              [s],
            )
          ).rows,
        ).toEqual([{ origin: "auto", status: "Investigating" }]);
        const [entry] = await audit(s, "status.override_cancelled");
        expect(entry).toMatchObject({
          actor_user_id: ids.owner,
          details: { incidentOpened: true },
        });
        expect(
          (
            await t.client.query(
              `SELECT end_reason, ended_by_user_id FROM status_overrides WHERE service_id = $1`,
              [s],
            )
          ).rows[0],
        ).toEqual({ end_reason: "cancelled", ended_by_user_id: ids.owner });
      });

      it("opens no incident when the service is healthy underneath", async () => {
        const s = await newService();
        await request(app)
          .post(`${base(s)}/override`)
          .set(as("owner"))
          .send({ ...withExpiry(), status: "Degraded" });
        expect(
          (
            await request(app)
              .delete(`${base(s)}/override`)
              .set(as("owner"))
          ).status,
        ).toBe(200);
        expect(
          (
            await t.client.query(
              `SELECT 1 FROM incidents WHERE service_id = $1`,
              [s],
            )
          ).rowCount,
        ).toBe(0);
      });

      it("answers 404 when there is no active override, and 403 below Owner", async () => {
        const s = await newService();
        expect(
          (
            await request(app)
              .delete(`${base(s)}/override`)
              .set(as("owner"))
          ).status,
        ).toBe(404);
        expect(
          (
            await request(app)
              .delete(`${base(s)}/override`)
              .set(as("responder"))
          ).status,
        ).toBe(403);
      });
    });

    describe("disable and enable (SP-02.9, SP-04.7)", () => {
      it("shows Unknown at once, records why, and audits who did it", async () => {
        const s = await newService();
        const res = await request(app)
          .post(`${base(s)}/disable`)
          .set(as("owner"));
        expect(res.status).toBe(200);
        expect(await row(s)).toEqual({
          current_status: "Unknown",
          computed_status: "Unknown",
          enabled: false,
        });
        const history = (
          await t.client.query(
            `SELECT status, source FROM service_status_history WHERE service_id = $1`,
            [s],
          )
        ).rows;
        expect(history).toEqual([{ status: "Unknown", source: "disabled" }]);
        expect((await audit(s, "service.disabled"))[0].actor_user_id).toBe(
          ids.owner,
        );
        expect(
          (
            await request(app)
              .post(`${base(s)}/disable`)
              .set(as("responder"))
          ).status,
        ).toBe(403);
      });

      it("restarts streaks: failures from before the service was disabled no longer count", async () => {
        const s = await newService();
        const record = async (passed: boolean, offsetMs: number) => {
          const when = new Date(Date.now() + offsetMs);
          const job = (
            await t.client.query(
              `INSERT INTO check_jobs (service_id, scheduled_for, status, attempts) VALUES ($1, $2, 'leased', 1) RETURNING id`,
              [s, when],
            )
          ).rows[0].id;
          return recordCheckResult(p.prisma, {
            jobId: job,
            serviceId: s,
            configVersion: 1,
            checkedAt: when,
            outcome: passed
              ? {
                  statusCode: 200,
                  latencyMs: 90,
                  passed: true,
                  failureReason: null,
                }
              : {
                  statusCode: 500,
                  latencyMs: 40,
                  passed: false,
                  failureReason: "status 500",
                },
          });
        };
        // two failures before the disable: one short of Outage (the failure threshold is 3)
        await record(false, -120_000);
        await record(false, -60_000);
        expect((await row(s)).current_status).toBe("Operational");

        await request(app)
          .post(`${base(s)}/disable`)
          .set(as("owner"));
        expect(
          (
            await request(app)
              .post(`${base(s)}/enable`)
              .set(as("owner"))
          ).status,
        ).toBe(200);
        expect((await row(s)).enabled).toBe(true);

        // a third failure in a row overall, but only the first since the service went Unknown
        await record(false, 5_000);
        expect((await row(s)).current_status).toBe("Unknown");
        await record(true, 10_000);
        expect((await row(s)).current_status).toBe("Operational"); // the first pass after Unknown
        expect((await audit(s, "service.enabled"))[0].actor_user_id).toBe(
          ids.owner,
        );
      });
    });
  },
);
