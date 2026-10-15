import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { signAccessToken } from "../../src/auth/tokens";
import { loadConfig } from "../../src/config";
import { openAutoIncident } from "../../src/db/incidents";
import { notifySubscribersOfPublicUpdate } from "../../src/db/subscriber-notify";
import {
  claimOutboxMessage,
  markOutboxDelivered,
  resetOutboxForRetry,
} from "../../src/db/outbox";
import { dispatcherTick } from "../../src/dispatcher/main";
import { MailSendError } from "../../src/dispatcher/send";
import {
  createTestDb,
  hasTestDb,
  prismaFor,
  type TestDb,
} from "../helpers/test-db";

const SECRET = "s".repeat(40);
const NOW = new Date("2026-10-15T15:00:00Z");

describe.skipIf(!hasTestDb)(
  "subscriber notifications, alert retry and privacy (SP-V22Y, SP-HSD0)",
  () => {
    let t: TestDb;
    let p: ReturnType<typeof prismaFor>;
    let config: ReturnType<typeof loadConfig>;
    let projectId: string;
    let slug: string;
    let publicServiceId: string;
    let privateServiceId: string;
    let ownerId: string;
    let ownerToken: string;
    let incidentId: string;

    beforeAll(async () => {
      t = await createTestDb();
      p = prismaFor(t);
      process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;
      process.env.CREDENTIALS_ENC_KEY = "k".repeat(32);
      process.env.JWT_SECRET = SECRET;
      config = loadConfig({
        DATABASE_URL: process.env.DATABASE_URL_TEST!,
        CREDENTIALS_ENC_KEY: "k".repeat(32),
        JWT_SECRET: SECRET,
      } as NodeJS.ProcessEnv);

      slug = `n-${randomBytes(4).toString("hex")}`;
      projectId = (
        await t.client.query(
          `INSERT INTO projects (name, slug) VALUES ('Notify Co', $1) RETURNING id`,
          [slug],
        )
      ).rows[0].id as string;

      publicServiceId = (
        await t.client.query(
          `INSERT INTO services
             (project_id, name, url, interval_seconds, timeout_seconds, is_public, enabled)
           VALUES ($1, 'API', 'https://example.com', 60, 5, true, true)
           RETURNING id`,
          [projectId],
        )
      ).rows[0].id as string;

      privateServiceId = (
        await t.client.query(
          `INSERT INTO services
             (project_id, name, url, interval_seconds, timeout_seconds, is_public, enabled)
           VALUES ($1, 'Secret', 'https://secret.internal', 60, 5, false, true)
           RETURNING id`,
          [projectId],
        )
      ).rows[0].id as string;

      ownerId = (
        await t.client.query(
          `INSERT INTO users (email, password_hash) VALUES ('owner@example.com', 'x') RETURNING id`,
        )
      ).rows[0].id as string;
      await t.client.query(
        `INSERT INTO memberships (project_id, user_id, role) VALUES ($1, $2, 'Owner')`,
        [projectId, ownerId],
      );
      ownerToken = signAccessToken(ownerId, SECRET, 3600);

      // Verified subscriber on the public service.
      const subId = (
        await t.client.query(
          `INSERT INTO subscribers (project_id, email, verified_at)
           VALUES ($1, 'fan@example.com', now()) RETURNING id`,
          [projectId],
        )
      ).rows[0].id as string;
      await t.client.query(
        `INSERT INTO subscriber_services (subscriber_id, service_id) VALUES ($1, $2)`,
        [subId, publicServiceId],
      );

      // Unverified subscriber must never be notified.
      const unverified = (
        await t.client.query(
          `INSERT INTO subscribers (project_id, email)
           VALUES ($1, 'pending@example.com') RETURNING id`,
          [projectId],
        )
      ).rows[0].id as string;
      await t.client.query(
        `INSERT INTO subscriber_services (subscriber_id, service_id) VALUES ($1, $2)`,
        [unverified, publicServiceId],
      );

      incidentId = (
        await t.client.query(
          `INSERT INTO incidents
             (project_id, service_id, title, origin, is_public, status)
           VALUES ($1, $2, 'API is down', 'auto', true, 'Investigating')
           RETURNING id`,
          [projectId, publicServiceId],
        )
      ).rows[0].id as string;
    }, 60_000);

    afterAll(async () => {
      await p.close();
      await t.close();
    });

    it("notifies only verified subscribers on a public update", async () => {
      const app = createApp({ config, prisma: p.prisma });

      const res = await request(app)
        .post(`/api/v1/projects/${projectId}/incidents/${incidentId}/updates`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          message: "We are investigating the outage",
          isPublic: true,
        });
      expect(res.status).toBe(201);

      const notes = await t.client.query(
        `SELECT recipient_email, kind, body FROM outbox_messages
          WHERE kind = 'subscriber_notification'
          ORDER BY recipient_email`,
      );
      expect(notes.rows).toHaveLength(1);
      expect(notes.rows[0].recipient_email).toBe("fan@example.com");
      expect(notes.rows[0].body).toContain("investigating");
      expect(notes.rows.map((r: { recipient_email: string }) => r.recipient_email)).not.toContain(
        "pending@example.com",
      );
    });

    it("does not notify on an internal update", async () => {
      const before = await t.client.query(
        `SELECT count(*)::int AS n FROM outbox_messages WHERE kind = 'subscriber_notification'`,
      );

      const app = createApp({ config, prisma: p.prisma });
      const res = await request(app)
        .post(`/api/v1/projects/${projectId}/incidents/${incidentId}/updates`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          message: "Internal: check rack 4",
          isPublic: false,
        });
      expect(res.status).toBe(201);

      const after = await t.client.query(
        `SELECT count(*)::int AS n FROM outbox_messages WHERE kind = 'subscriber_notification'`,
      );
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it("auto-open on a public service notifies verified subscribers", async () => {
      // New public service with a verified subscriber, no incident yet.
      const svc = (
        await t.client.query(
          `INSERT INTO services
             (project_id, name, url, interval_seconds, timeout_seconds, is_public, enabled)
           VALUES ($1, 'Web', 'https://web.example', 60, 5, true, true)
           RETURNING id`,
          [projectId],
        )
      ).rows[0].id as string;
      const sub = (
        await t.client.query(
          `INSERT INTO subscribers (project_id, email, verified_at)
           VALUES ($1, 'web-fan@example.com', now()) RETURNING id`,
          [projectId],
        )
      ).rows[0].id as string;
      await t.client.query(
        `INSERT INTO subscriber_services (subscriber_id, service_id) VALUES ($1, $2)`,
        [sub, svc],
      );

      const before = await t.client.query(
        `SELECT count(*)::int AS n FROM outbox_messages
          WHERE kind = 'subscriber_notification' AND recipient_email = 'web-fan@example.com'`,
      );

      await p.prisma.$transaction(async (tx) => {
        await openAutoIncident(tx as Parameters<typeof openAutoIncident>[0], svc);
      });

      const after = await t.client.query(
        `SELECT body FROM outbox_messages
          WHERE kind = 'subscriber_notification' AND recipient_email = 'web-fan@example.com'`,
      );
      expect(after.rows.length).toBe(before.rows[0].n + 1);
      expect(after.rows[after.rows.length - 1].body).toContain("Outage");
    });

    it("public page never leaks private service data or credentials", async () => {
      const app = createApp({ config, prisma: p.prisma });
      const res = await request(app).get(`/api/v1/public/${slug}`);
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain("secret.internal");
      expect(body).not.toContain("Secret");
      expect(body).not.toContain("Internal:");
      expect(body).not.toContain(privateServiceId);
    });

    it("alert retry re-queues a failed delivery for the dispatcher", async () => {
      await t.client.query(
        `UPDATE outbox_messages SET delivered_at = COALESCE(delivered_at, $1)`,
        [NOW.toISOString()],
      );

      const existing = await t.client.query(
        `SELECT id FROM alerts WHERE service_id = $1 AND incident_id = $2 LIMIT 1`,
        [publicServiceId, incidentId],
      );
      let aid: string;
      if (existing.rows.length) {
        aid = existing.rows[0].id as string;
      } else {
        aid = (
          await t.client.query(
            `INSERT INTO alerts (project_id, service_id, incident_id, state)
             VALUES ($1, $2, $3, 'Outage') RETURNING id`,
            [projectId, publicServiceId, incidentId],
          )
        ).rows[0].id as string;
      }

      const msgId = (
        await t.client.query(
          `INSERT INTO outbox_messages
             (project_id, kind, alert_id, recipient_email, subject, body, attempts, next_attempt_at)
           VALUES ($1, 'alert', $2, 'ops-retry@fail.example', 'down', 'body', 6, $3)
           RETURNING id`,
          [projectId, aid, NOW.toISOString()],
        )
      ).rows[0].id as string;

      const stuck = await t.client.query(
        `SELECT attempts FROM outbox_messages WHERE id = $1`,
        [msgId],
      );
      expect(stuck.rows[0].attempts).toBe(6);

      const app = createApp({ config, prisma: p.prisma });
      const retry = await request(app)
        .post(`/api/v1/projects/${projectId}/alerts/${aid}/retry`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(retry.status).toBe(200);
      expect(retry.body.reset).toBeGreaterThan(0);

      const after = await t.client.query(
        `SELECT attempts, delivered_at FROM outbox_messages WHERE id = $1`,
        [msgId],
      );
      expect(after.rows[0].attempts).toBe(0);
      expect(after.rows[0].delivered_at).toBeNull();

      await t.client.query(
        `UPDATE outbox_messages SET delivered_at = $1 WHERE id <> $2 AND delivered_at IS NULL`,
        [NOW.toISOString(), msgId],
      );
      let calls = 0;
      // API retry uses systemClock.now(); claim with wall-clock time.
      const wall = new Date();
      const did = await dispatcherTick(
        t.client as unknown as PoolClient,
        async () => {
          calls += 1;
          throw new MailSendError("still failing");
        },
        wall,
        30,
        6,
      );
      expect(did).toBe(true);
      expect(calls).toBe(1);
    });

    it("payment idempotency: same key does not double-charge", async () => {
      const app = createApp({ config, prisma: p.prisma });
      const key = `pay-${randomBytes(6).toString("hex")}`;

      const first = await request(app)
        .post(`/api/v1/projects/${projectId}/plan`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", key)
        .send({ planName: "pro" });
      expect([200, 201]).toContain(first.status);
      expect(first.body.payment.status).toBe("succeeded");

      const second = await request(app)
        .post(`/api/v1/projects/${projectId}/plan`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", key)
        .send({ planName: "pro" });
      expect(second.status).toBe(200);
      expect(second.body.payment.id).toBe(first.body.payment.id);

      const n = await t.client.query(
        `SELECT count(*)::int AS n FROM payment_attempts WHERE idempotency_key = $1`,
        [key],
      );
      expect(n.rows[0].n).toBe(1);
    });
  },
);
