import { randomBytes } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { signAccessToken } from "../../src/auth/tokens";
import { loadConfig } from "../../src/config";
import { sharedAuthRateLimitStore } from "../../src/middleware/rate-limit";
import {
  createTestDb,
  hasTestDb,
  prismaFor,
  type TestDb,
} from "../helpers/test-db";

const SECRET = "s".repeat(40);

describe.skipIf(!hasTestDb)("subscribe, verify and plan upgrade", () => {
  let t: TestDb;
  let p: ReturnType<typeof prismaFor>;
  let config: ReturnType<typeof loadConfig>;
  let slug: string;
  let projectId: string;
  let publicServiceId: string;
  let privateServiceId: string;
  let ownerId: string;
  let ownerToken: string;

  beforeAll(async () => {
    t = await createTestDb();
    p = prismaFor(t);
    process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;
    process.env.CREDENTIALS_ENC_KEY = "k".repeat(32);
    process.env.JWT_SECRET = SECRET;
    delete process.env.PAYMENT_FAIL_ALL;
    config = loadConfig({
      DATABASE_URL: process.env.DATABASE_URL_TEST!,
      CREDENTIALS_ENC_KEY: "k".repeat(32),
      JWT_SECRET: SECRET,
    } as NodeJS.ProcessEnv);

    slug = `sub-${randomBytes(4).toString("hex")}`;
    projectId = (
      await t.client.query(
        `INSERT INTO projects (name, slug) VALUES ('Sub Co', $1) RETURNING id`,
        [slug],
      )
    ).rows[0].id as string;

    publicServiceId = (
      await t.client.query(
        `INSERT INTO services
           (project_id, name, url, interval_seconds, timeout_seconds, is_public, enabled)
         VALUES ($1, 'Public API', 'https://example.com', 60, 5, true, true)
         RETURNING id`,
        [projectId],
      )
    ).rows[0].id as string;

    privateServiceId = (
      await t.client.query(
        `INSERT INTO services
           (project_id, name, url, interval_seconds, timeout_seconds, is_public, enabled)
         VALUES ($1, 'Private', 'https://private.example', 60, 5, false, true)
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
  }, 60_000);

  afterAll(async () => {
    await p.close();
    await t.close();
  });

  beforeEach(() => {
    sharedAuthRateLimitStore.clear();
    delete process.env.PAYMENT_FAIL_ALL;
  });

  it("subscribes to a public service and verifies with a single-use token", async () => {
    const app = createApp({ config, prisma: p.prisma });

    const sub = await request(app)
      .post(`/public/${slug}/subscribe`)
      .send({ email: "visitor@example.com", serviceIds: [publicServiceId] });
    expect(sub.status).toBe(201);
    expect(sub.body.subscriber.email).toBe("visitor@example.com");
    expect(sub.body.subscriber.verified).toBe(false);
    expect(sub.body.verificationToken).toBeTruthy();

    const token = sub.body.verificationToken as string;

    const outbox = await t.client.query(
      `SELECT kind FROM outbox_messages
        WHERE recipient_email = 'visitor@example.com' AND kind = 'subscription_verification'`,
    );
    expect(outbox.rows).toHaveLength(1);

    const again = await request(app)
      .post(`/public/${slug}/subscribe`)
      .send({ email: "visitor@example.com", serviceIds: [publicServiceId] });
    expect(again.status).toBe(201);
    const count = await t.client.query(
      `SELECT count(*)::int AS n FROM subscribers WHERE project_id = $1 AND email = 'visitor@example.com'`,
      [projectId],
    );
    expect(count.rows[0].n).toBe(1);

    const latestToken = again.body.verificationToken as string;
    const verified = await request(app)
      .post("/public/subscriptions/verify")
      .send({ token: latestToken });
    expect(verified.status).toBe(200);
    expect(verified.body.subscriber.verified).toBe(true);

    const reuse = await request(app)
      .post("/public/subscriptions/verify")
      .send({ token: latestToken });
    expect(reuse.status).toBe(410);

    const old = await request(app)
      .post("/public/subscriptions/verify")
      .send({ token });
    expect(old.status).toBe(410);
  });

  it("rejects subscribe to a private service", async () => {
    const app = createApp({ config, prisma: p.prisma });
    const res = await request(app)
      .post(`/public/${slug}/subscribe`)
      .send({ email: "other@example.com", serviceIds: [privateServiceId] });
    expect(res.status).toBe(422);
  });

  it("upgrades plan with Idempotency-Key exactly once", async () => {
    const app = createApp({ config, prisma: p.prisma });
    const key = `key-${randomBytes(8).toString("hex")}`;

    const first = await request(app)
      .post(`/projects/${projectId}/plan`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", key)
      .send({ planName: "pro" });
    expect(first.status).toBe(201);
    expect(first.body.plan.name).toBe("pro");
    expect(first.body.payment.status).toBe("succeeded");

    const replay = await request(app)
      .post(`/projects/${projectId}/plan`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", key)
      .send({ planName: "pro" });
    expect(replay.status).toBe(200);
    expect(replay.body.payment.id).toBe(first.body.payment.id);

    const attempts = await t.client.query(
      `SELECT count(*)::int AS n FROM payment_attempts WHERE project_id = $1 AND idempotency_key = $2`,
      [projectId, key],
    );
    expect(attempts.rows[0].n).toBe(1);

    const conflict = await request(app)
      .post(`/projects/${projectId}/plan`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", key)
      .send({ planName: "free" });
    expect(conflict.status).toBe(422);
  });

  it("leaves plan unchanged when simulated payment fails", async () => {
    const app = createApp({ config, prisma: p.prisma });
    await t.client.query(
      `UPDATE projects SET plan_id = (SELECT id FROM plans WHERE name = 'free') WHERE id = $1`,
      [projectId],
    );
    process.env.PAYMENT_FAIL_ALL = "1";
    const key = `fail-${randomBytes(8).toString("hex")}`;
    const res = await request(app)
      .post(`/projects/${projectId}/plan`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("Idempotency-Key", key)
      .send({ planName: "pro" });
    expect(res.status).toBe(409);

    const plan = await t.client.query(
      `SELECT p.name FROM projects pr JOIN plans p ON p.id = pr.plan_id WHERE pr.id = $1`,
      [projectId],
    );
    expect(plan.rows[0].name).toBe("free");
  });
});
