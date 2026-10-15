import { randomBytes } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { signAccessToken } from "../../src/auth/tokens";
import { loadConfig } from "../../src/config";
import {
  createAlertForIncident,
  openAutoIncident,
} from "../../src/db/incidents";
import { recordCheckResult } from "../../src/db/record-result";
import {
  createTestDb,
  hasTestDb,
  prismaFor,
  type TestDb,
} from "../helpers/test-db";

const SECRET = "s".repeat(40);
const T0 = new Date("2026-10-11T12:00:00Z").getTime();
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

describe.skipIf(!hasTestDb)(
  "alert and outbox creation (SP-06.1, SP-06.2)",
  () => {
    let t: TestDb;
    let p: ReturnType<typeof prismaFor>;
    let app: ReturnType<typeof createApp>;
    let projectId: string;
    let ids: Record<"owner" | "responder" | "viewer", string>;
    let n = 0;
    let minute = 0;

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
        owner: await user("owner@example.com"),
        responder: await user("responder@example.com"),
        viewer: await user("viewer@example.com"),
      };
      await user("outsider@example.com");
      projectId = (
        await t.client.query(
          `INSERT INTO projects (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
        )
      ).rows[0].id;
      for (const [who, role] of [
        ["owner", "Owner"],
        ["responder", "Responder"],
        ["viewer", "Viewer"],
      ] as const)
        await t.client.query(
          `INSERT INTO memberships (project_id, user_id, role) VALUES ($1, $2, $3)`,
          [projectId, ids[who], role],
        );
    });
    afterAll(async () => {
      await p?.close();
      await t?.close();
    });

    async function newService(isPublic = false) {
      n += 1;
      return (
        await t.client.query(
          `INSERT INTO services (project_id, name, url, interval_seconds, timeout_seconds, fail_threshold, recovery_threshold, slow_threshold, is_public, status_since, computed_since)
         VALUES ($1, $2, 'https://secret.internal.example/health?token=abc', 60, 5, 3, 2, 3, $3, $4, $4) RETURNING id`,
          [projectId, `svc-${n}`, isPublic, at(-24 * 60)],
        )
      ).rows[0].id as string;
    }
    async function fail(serviceId: string, when?: Date) {
      minute += 1;
      when ??= at(minute);
      const job = (
        await t.client.query(
          `INSERT INTO check_jobs (service_id, scheduled_for, status, attempts) VALUES ($1, $2, 'leased', 1) RETURNING id`,
          [serviceId, when],
        )
      ).rows[0].id as string;
      return recordCheckResult(p.prisma, {
        jobId: job,
        serviceId,
        configVersion: 1,
        outcome: {
          statusCode: 500,
          latencyMs: 40,
          passed: false,
          failureReason: "status 500",
        },
        checkedAt: when,
      });
    }
    const alertsOf = async (serviceId: string) =>
      (
        await t.client.query(
          `SELECT id, incident_id, state FROM alerts WHERE service_id = $1 ORDER BY created_at`,
          [serviceId],
        )
      ).rows;
    const messagesOf = async (alertId: string) =>
      (
        await t.client.query(
          `SELECT * FROM outbox_messages WHERE alert_id = $1 ORDER BY recipient_email`,
          [alertId],
        )
      ).rows;

    it("creates one alert with a message for each owner and responder when the worker opens an incident", async () => {
      const svc = await newService();
      await fail(svc);
      await fail(svc);
      expect(await alertsOf(svc)).toHaveLength(0);
      await fail(svc); // third failure reaches the threshold
      const alerts = await alertsOf(svc);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].state).toBe("Outage");
      const incident = await t.client.query(
        `SELECT id FROM incidents WHERE service_id = $1`,
        [svc],
      );
      expect(alerts[0].incident_id).toBe(incident.rows[0].id);

      const messages = await messagesOf(alerts[0].id);
      expect(messages.map((m) => m.recipient_email)).toEqual([
        "owner@example.com",
        "responder@example.com",
      ]);
      for (const m of messages) {
        expect(m).toMatchObject({
          kind: "alert",
          attempts: 0,
          delivered_at: null,
          lease_until: null,
          last_error: null,
        });
        expect(m.subject).toBe("[Acme] svc-" + n + " is down");
        expect(m.body).not.toContain("secret.internal.example");
        expect(m.body).not.toContain("token=abc");
      }
    });

    it("creates no second alert while the outage continues", async () => {
      const svc = await newService();
      for (let i = 0; i < 6; i += 1) await fail(svc);
      const alerts = await alertsOf(svc);
      expect(alerts).toHaveLength(1);
      expect(await messagesOf(alerts[0].id)).toHaveLength(2);
    });

    it("creates the alert for a private service too", async () => {
      const svc = await newService(false);
      for (let i = 0; i < 3; i += 1) await fail(svc);
      expect(await alertsOf(svc)).toHaveLength(1);
    });

    it("creates no alert while an override is active, and one when it is cancelled during the outage", async () => {
      const svc = await newService();
      await t.client.query(
        `INSERT INTO status_overrides (service_id, status, reason, actor_user_id, expires_at) VALUES ($1, 'Operational', 'maintenance', $2, now() + interval '1 hour')`,
        [svc, ids.owner],
      );
      for (let i = 3; i >= 1; i -= 1)
        await fail(svc, new Date(Date.now() - i * 10_000));
      expect(await alertsOf(svc)).toHaveLength(0);
      expect(
        (
          await t.client.query(
            `SELECT count(*)::int AS n FROM incidents WHERE service_id = $1`,
            [svc],
          )
        ).rows[0].n,
      ).toBe(0);

      const res = await request(app)
        .delete(`/api/v1/projects/${projectId}/services/${svc}/override`)
        .set({
          Authorization: `Bearer ${signAccessToken(ids.owner, SECRET, 900)}`,
        });
      expect(res.status).toBe(200);
      const alerts = await alertsOf(svc);
      expect(alerts).toHaveLength(1);
      expect(await messagesOf(alerts[0].id)).toHaveLength(2);
    });

    it("creates no alert for an incident a responder opens by hand", async () => {
      const svc = await newService();
      const res = await request(app)
        .post(`/api/v1/projects/${projectId}/incidents`)
        .set({
          Authorization: `Bearer ${signAccessToken(ids.responder, SECRET, 900)}`,
        })
        .send({ serviceId: svc, title: "Planned maintenance" });
      expect(res.status).toBe(201);
      expect(await alertsOf(svc)).toHaveLength(0);
    });

    it("gives each outage its own alert", async () => {
      const svc = await newService();
      const first = await p.prisma.$transaction((tx) =>
        openAutoIncident(tx, svc),
      );
      await t.client.query(
        `UPDATE incidents SET status = 'Resolved', resolved_at = now() WHERE id = $1`,
        [first],
      );
      const second = await p.prisma.$transaction((tx) =>
        openAutoIncident(tx, svc),
      );
      expect(second).not.toBe(first);
      const alerts = await alertsOf(svc);
      expect(alerts.map((a) => a.incident_id)).toEqual([first, second]);
    });

    it("creates nothing the second time for the same incident", async () => {
      const svc = await newService();
      const incident = (await p.prisma.$transaction((tx) =>
        openAutoIncident(tx, svc),
      ))!;
      const again = await p.prisma.$transaction((tx) =>
        createAlertForIncident(tx, incident),
      );
      expect(again).toBeNull();
      const alerts = await alertsOf(svc);
      expect(alerts).toHaveLength(1);
      expect(await messagesOf(alerts[0].id)).toHaveLength(2);
    });

    it("never leaves an incident without its alert: a failure after opening rolls both back", async () => {
      const svc = await newService();
      await expect(
        p.prisma.$transaction(async (tx) => {
          await openAutoIncident(tx, svc);
          throw new Error("crash before commit");
        }),
      ).rejects.toThrow("crash before commit");
      expect(await alertsOf(svc)).toHaveLength(0);
      expect(
        (
          await t.client.query(
            `SELECT count(*)::int AS n FROM incidents WHERE service_id = $1`,
            [svc],
          )
        ).rows[0].n,
      ).toBe(0);
    });

    it("follows a member's role at the moment the alert is created", async () => {
      const svc = await newService();
      await t.client.query(
        `UPDATE memberships SET role = 'Responder' WHERE project_id = $1 AND user_id = $2`,
        [projectId, ids.viewer],
      );
      const incident = (await p.prisma.$transaction((tx) =>
        openAutoIncident(tx, svc),
      ))!;
      await t.client.query(
        `UPDATE memberships SET role = 'Viewer' WHERE project_id = $1 AND user_id = $2`,
        [projectId, ids.viewer],
      );
      const alert = (await alertsOf(svc))[0];
      expect(alert.incident_id).toBe(incident);
      expect(
        (await messagesOf(alert.id)).map((m) => m.recipient_email),
      ).toContain("viewer@example.com");
    });

    describe("constraints", () => {
      it("rejects an alert message without an alert and an alert link on another kind", async () => {
        await expect(
          t.client.query(
            `INSERT INTO outbox_messages (project_id, kind, recipient_email, subject, body) VALUES ($1, 'alert', 'a@x.io', 's', 'b')`,
            [projectId],
          ),
        ).rejects.toThrow(/outbox_messages_alert_link/);
        const svc = await newService();
        await p.prisma.$transaction((tx) => openAutoIncident(tx, svc));
        const alert = (await alertsOf(svc))[0];
        await expect(
          t.client.query(
            `INSERT INTO outbox_messages (project_id, kind, alert_id, recipient_email, subject, body) VALUES ($1, 'subscriber_notification', $2, 'a@x.io', 's', 'b')`,
            [projectId, alert.id],
          ),
        ).rejects.toThrow(/outbox_messages_alert_link/);
      });

      it("allows one acknowledgement per alert and one message per recipient", async () => {
        const svc = await newService();
        await p.prisma.$transaction((tx) => openAutoIncident(tx, svc));
        const alert = (await alertsOf(svc))[0];
        await t.client.query(
          `INSERT INTO acknowledgements (alert_id, actor_user_id) VALUES ($1, $2)`,
          [alert.id, ids.owner],
        );
        await expect(
          t.client.query(
            `INSERT INTO acknowledgements (alert_id, actor_user_id) VALUES ($1, $2)`,
            [alert.id, ids.responder],
          ),
        ).rejects.toThrow(/duplicate key/);
        await expect(
          t.client.query(
            `INSERT INTO outbox_messages (project_id, kind, alert_id, recipient_email, subject, body) VALUES ($1, 'alert', $2, 'owner@example.com', 's', 'b')`,
            [projectId, alert.id],
          ),
        ).rejects.toThrow(/outbox_messages_one_per_recipient/);
      });

      it("rejects an unknown alert state and a second alert for the same problem", async () => {
        const svc = await newService();
        const incident = (await p.prisma.$transaction((tx) =>
          openAutoIncident(tx, svc),
        ))!;
        await expect(
          t.client.query(
            `INSERT INTO alerts (project_id, service_id, incident_id, state) VALUES ($1, $2, $3, 'Operational')`,
            [projectId, svc, incident],
          ),
        ).rejects.toThrow(/alerts_state_check/);
        await expect(
          t.client.query(
            `INSERT INTO alerts (project_id, service_id, incident_id, state) VALUES ($1, $2, $3, 'Outage')`,
            [projectId, svc, incident],
          ),
        ).rejects.toThrow(/alerts_one_per_problem/);
      });

      it("removes alerts and messages with their project's incident", async () => {
        const svc = await newService();
        const incident = (await p.prisma.$transaction((tx) =>
          openAutoIncident(tx, svc),
        ))!;
        await t.client.query(`DELETE FROM incidents WHERE id = $1`, [incident]);
        expect(await alertsOf(svc)).toHaveLength(0);
      });
    });
  },
);
