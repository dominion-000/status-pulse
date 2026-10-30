import { randomBytes } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { signAccessToken } from "../../src/auth/tokens";
import { loadConfig } from "../../src/config";
import type { PoolClient } from "pg";
import {
  claimOutboxMessage,
  markOutboxDelivered,
  markOutboxFailed,
  outboxBackoffSeconds,
  resetOutboxForRetry,
} from "../../src/db/outbox";
import { dispatcherTick } from "../../src/dispatcher/main";
import { createDefaultSender, MailSendError } from "../../src/dispatcher/send";
import {
  createTestDb,
  hasTestDb,
  prismaFor,
  type TestDb,
} from "../helpers/test-db";

const SECRET = "s".repeat(40);
const NOW = new Date("2026-10-15T12:00:00Z");

describe.skipIf(!hasTestDb)("dispatcher and alerts API", () => {
  let t: TestDb;
  let p: ReturnType<typeof prismaFor>;
  let projectId: string;
  let ownerId: string;
  let responderId: string;
  let viewerId: string;
  let serviceId: string;
  let alertId: string;
  let ownerToken: string;
  let responderToken: string;
  let viewerToken: string;
  let config: ReturnType<typeof loadConfig>;

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

    ownerId = (
      await t.client.query(
        `INSERT INTO users (email, password_hash) VALUES ('owner@example.com', 'x') RETURNING id`,
      )
    ).rows[0].id;
    responderId = (
      await t.client.query(
        `INSERT INTO users (email, password_hash) VALUES ('responder@example.com', 'x') RETURNING id`,
      )
    ).rows[0].id;
    viewerId = (
      await t.client.query(
        `INSERT INTO users (email, password_hash) VALUES ('viewer@example.com', 'x') RETURNING id`,
      )
    ).rows[0].id;

    projectId = (
      await t.client.query(
        `INSERT INTO projects (name, slug) VALUES ('Demo', $1) RETURNING id`,
        [`demo-${randomBytes(4).toString("hex")}`],
      )
    ).rows[0].id;

    await t.client.query(
      `INSERT INTO memberships (project_id, user_id, role) VALUES
        ($1, $2, 'Owner'), ($1, $3, 'Responder'), ($1, $4, 'Viewer')`,
      [projectId, ownerId, responderId, viewerId],
    );

    serviceId = (
      await t.client.query(
        `INSERT INTO services (project_id, name, url, interval_seconds, timeout_seconds)
         VALUES ($1, 'API', 'https://example.com/health', 60, 5) RETURNING id`,
        [projectId],
      )
    ).rows[0].id;

    const incidentId = (
      await t.client.query(
        `INSERT INTO incidents (project_id, service_id, title, origin, is_public, status)
         VALUES ($1, $2, 'API: outage detected', 'auto', false, 'Investigating') RETURNING id`,
        [projectId, serviceId],
      )
    ).rows[0].id;

    alertId = (
      await t.client.query(
        `INSERT INTO alerts (project_id, service_id, incident_id, state)
         VALUES ($1, $2, $3, 'Outage') RETURNING id`,
        [projectId, serviceId, incidentId],
      )
    ).rows[0].id;

    // Explicit next_attempt_at so claim with fixed NOW succeeds.
    await t.client.query(
      `INSERT INTO outbox_messages (project_id, kind, alert_id, recipient_email, subject, body, next_attempt_at)
       VALUES
         ($1, 'alert', $2, 'owner@example.com', 'down', 'body', $3),
         ($1, 'alert', $2, 'bad@fail.example', 'down', 'body', $3)`,
      [projectId, alertId, NOW.toISOString()],
    );

    ownerToken = signAccessToken(ownerId, SECRET, 3600);
    responderToken = signAccessToken(responderId, SECRET, 3600);
    viewerToken = signAccessToken(viewerId, SECRET, 3600);
  }, 60_000);

  afterAll(async () => {
    if (p) await p.close();
    if (t) await t.close();
  });

  it("delivers a message and leaves fail.example undelivered with backoff", async () => {
    // Use the test-schema client (search_path already set).
    const pool = t.client as PoolClient;
    const sender = createDefaultSender({ MAIL_FAIL_ALL: "0" });

    const first = await claimOutboxMessage(pool, NOW, 30, 6);
    expect(first).not.toBeNull();
    expect(first!.attempts).toBe(1);

    const second = await claimOutboxMessage(pool, NOW, 30, 6);
    expect(second).not.toBeNull();
    expect(second!.attempts).toBe(1);

    const emails = new Set([first!.recipient_email, second!.recipient_email]);
    expect(emails).toEqual(new Set(["owner@example.com", "bad@fail.example"]));

    const good =
      first!.recipient_email === "owner@example.com" ? first! : second!;
    const failMsg =
      first!.recipient_email === "bad@fail.example" ? first! : second!;

    await markOutboxDelivered(pool, good.id, NOW);

    const delivered = await t.client.query(
      `SELECT delivered_at FROM outbox_messages WHERE id = $1`,
      [good.id],
    );
    expect(delivered.rows[0].delivered_at).not.toBeNull();

    await expect(
      sender({
        to: failMsg!.recipient_email,
        subject: failMsg!.subject,
        body: failMsg!.body,
      }),
    ).rejects.toBeInstanceOf(MailSendError);

    const delay = outboxBackoffSeconds(failMsg!.attempts);
    const next = new Date(NOW.getTime() + delay * 1000);
    await markOutboxFailed(pool, failMsg!.id, "fail.example", next);

    const row = await t.client.query(
      `SELECT delivered_at, attempts, last_error FROM outbox_messages WHERE id = $1`,
      [failMsg!.id],
    );
    expect(row.rows[0].delivered_at).toBeNull();
    expect(row.rows[0].attempts).toBe(1);
    expect(row.rows[0].last_error).toContain("fail.example");
  });

  it("dispatcherTick stops after 6 attempts and retry resets", async () => {
    const ins = await t.client.query(
      `INSERT INTO outbox_messages (project_id, kind, alert_id, recipient_email, subject, body, next_attempt_at)
       VALUES ($1, 'alert', $2, 'retry@fail.example', 's', 'b', $3) RETURNING id`,
      [projectId, alertId, NOW.toISOString()],
    );
    const msgId = ins.rows[0].id as string;
    await t.client.query(
      `UPDATE projects SET plan_id = (SELECT id FROM plans WHERE name = 'pro') WHERE id = $1`,
      [projectId],
    );
    let calls = 0;
    const failingSender = async () => {
      calls += 1;
      throw new MailSendError("forced");
    };

    // Isolate: mark any other pending messages as delivered so only msgId is claimable.
    await t.client.query(
      `UPDATE outbox_messages SET delivered_at = $1 WHERE id <> $2 AND delivered_at IS NULL`,
      [NOW.toISOString(), msgId],
    );

    let now = new Date(NOW.getTime());
    for (let i = 0; i < 6; i++) {
      const did = await dispatcherTick(
        t.client as PoolClient,
        failingSender,
        now,
        30,
        6,
      );
      expect(did).toBe(true);
      now = new Date(now.getTime() + 400_000);
    }
    expect(calls).toBe(6);

    const did = await dispatcherTick(
      t.client as PoolClient,
      failingSender,
      now,
      30,
      6,
    );
    expect(did).toBe(false);
    expect(calls).toBe(6);

    const row = await t.client.query(
      `SELECT attempts, delivered_at FROM outbox_messages WHERE id = $1`,
      [msgId],
    );
    expect(row.rows[0].attempts).toBe(6);
    expect(row.rows[0].delivered_at).toBeNull();

    await resetOutboxForRetry(t.client as PoolClient, msgId, now);
    const after = await t.client.query(
      `SELECT attempts FROM outbox_messages WHERE id = $1`,
      [msgId],
    );
    expect(after.rows[0].attempts).toBe(0);
  });

  it("lists alerts for responder and forbids viewer", async () => {
    const app = createApp({ config, prisma: p.prisma });

    const ok = await request(app)
      .get(`/api/v1/projects/${projectId}/alerts`)
      .set("Authorization", `Bearer ${responderToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body.alerts.length).toBeGreaterThanOrEqual(1);
    expect(ok.body.alerts[0]).toHaveProperty("messages");

    const denied = await request(app)
      .get(`/api/v1/projects/${projectId}/alerts`)
      .set("Authorization", `Bearer ${viewerToken}`);
    expect(denied.status).toBe(403);
  });

  it("acknowledges an alert idempotently", async () => {
    const app = createApp({ config, prisma: p.prisma });

    const first = await request(app)
      .post(`/api/v1/projects/${projectId}/alerts/${alertId}/acknowledge`)
      .set("Authorization", `Bearer ${responderToken}`);
    expect(first.status).toBe(201);
    expect(first.body.acknowledgement.actorUserId).toBe(responderId);

    const second = await request(app)
      .post(`/api/v1/projects/${projectId}/alerts/${alertId}/acknowledge`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(second.status).toBe(200);
    expect(second.body.acknowledgement.actorUserId).toBe(responderId);
    expect(second.body.acknowledgement.id).toBe(first.body.acknowledgement.id);
  });

  it("retries undelivered messages", async () => {
    const app = createApp({ config, prisma: p.prisma });

    const pending = await t.client.query(
      `SELECT count(*)::int AS n FROM outbox_messages WHERE alert_id = $1 AND delivered_at IS NULL`,
      [alertId],
    );
    expect(pending.rows[0].n).toBeGreaterThan(0);

    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/alerts/${alertId}/retry`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.reset).toBeGreaterThan(0);
  });
});
