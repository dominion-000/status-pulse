import { randomBytes } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { loadConfig } from "../../src/config";
import {
  createTestDb,
  hasTestDb,
  prismaFor,
  type TestDb,
} from "../helpers/test-db";

const SECRET = "s".repeat(40);
const T0 = new Date("2026-10-15T12:00:00Z");

describe.skipIf(!hasTestDb)("public status page", () => {
  let t: TestDb;
  let p: ReturnType<typeof prismaFor>;
  let config: ReturnType<typeof loadConfig>;
  let slug: string;
  let publicServiceId: string;
  let privateServiceId: string;
  let disabledServiceId: string;
  let publicIncidentId: string;

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

    slug = `pub-${randomBytes(4).toString("hex")}`;
    const projectId = (
      await t.client.query(
        `INSERT INTO projects (name, slug) VALUES ('Public Co', $1) RETURNING id`,
        [slug],
      )
    ).rows[0].id as string;

    publicServiceId = (
      await t.client.query(
        `INSERT INTO services
           (project_id, name, url, interval_seconds, timeout_seconds, is_public, enabled,
            current_status, status_since, computed_status, computed_since)
         VALUES ($1, 'Public API', 'https://secret.internal/health?token=abc', 60, 5, true, true,
            'Outage', $2, 'Outage', $2)
         RETURNING id`,
        [projectId, T0.toISOString()],
      )
    ).rows[0].id as string;

    privateServiceId = (
      await t.client.query(
        `INSERT INTO services
           (project_id, name, url, interval_seconds, timeout_seconds, is_public, enabled,
            current_status, status_since, computed_status, computed_since)
         VALUES ($1, 'Private DB', 'https://db.internal/health', 60, 5, false, true,
            'Operational', $2, 'Operational', $2)
         RETURNING id`,
        [projectId, T0.toISOString()],
      )
    ).rows[0].id as string;

    disabledServiceId = (
      await t.client.query(
        `INSERT INTO services
           (project_id, name, url, interval_seconds, timeout_seconds, is_public, enabled,
            current_status, status_since, computed_status, computed_since)
         VALUES ($1, 'Disabled', 'https://old.example/health', 60, 5, true, false,
            'Unknown', $2, 'Unknown', $2)
         RETURNING id`,
        [projectId, T0.toISOString()],
      )
    ).rows[0].id as string;

    const actorId = (
      await t.client.query(
        `INSERT INTO users (email, password_hash) VALUES ('actor@example.com', 'x') RETURNING id`,
      )
    ).rows[0].id as string;

    // Active public incident on the public service, with one public and one internal update.
    publicIncidentId = (
      await t.client.query(
        `INSERT INTO incidents
           (project_id, service_id, title, origin, is_public, status)
         VALUES ($1, $2, 'Public API is down', 'auto', true, 'Investigating')
         RETURNING id`,
        [projectId, publicServiceId],
      )
    ).rows[0].id as string;

    await t.client.query(
      `INSERT INTO incident_updates (incident_id, status, message, is_public, actor_user_id)
       VALUES
         ($1, 'Investigating', 'We are looking into it', true, $2),
         ($1, 'Investigating', 'Internal note: check rack 3', false, $2)`,
      [publicIncidentId, actorId],
    );

    // Incident on private service (flag true should still be hidden).
    await t.client.query(
      `INSERT INTO incidents
         (project_id, service_id, title, origin, is_public, status)
       VALUES ($1, $2, 'Private outage', 'auto', true, 'Investigating')`,
      [projectId, privateServiceId],
    );

    // Status history for the public service.
    await t.client.query(
      `INSERT INTO service_status_history
         (service_id, status, computed_status, source, started_at)
       VALUES
         ($1, 'Operational', 'Operational', 'computed', $2),
         ($1, 'Outage', 'Outage', 'computed', $3)`,
      [
        publicServiceId,
        new Date(T0.getTime() - 3600_000).toISOString(),
        T0.toISOString(),
      ],
    );
  }, 60_000);

  afterAll(async () => {
    if (p) await p.close();
    if (t) await t.close();
  });

  it("returns only public enabled services and public incident data", async () => {
    const app = createApp({ config, prisma: p.prisma });
    const res = await request(app).get(`/api/v1/public/${slug}`);

    expect(res.status).toBe(200);
    expect(res.body.project).toEqual({ name: "Public Co", slug });

    const services = res.body.services as Array<Record<string, unknown>>;
    expect(services).toHaveLength(1);
    expect(services[0]!.id).toBe(publicServiceId);
    expect(services[0]!.name).toBe("Public API");
    expect(services[0]!.currentStatus).toBe("Outage");

    // Private and disabled services must not appear.
    const names = services.map((s) => s.name);
    expect(names).not.toContain("Private DB");
    expect(names).not.toContain("Disabled");

    // Credentials / URL must never appear.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("secret.internal");
    expect(body).not.toContain("token=abc");
    expect(body).not.toContain("db.internal");
    expect(body).not.toContain("Internal note");

    const incident = services[0]!.activeIncident as {
      id: string;
      title: string;
      updates: Array<{ message: string }>;
    };
    expect(incident).not.toBeNull();
    expect(incident.id).toBe(publicIncidentId);
    expect(incident.title).toBe("Public API is down");
    expect(incident.updates).toHaveLength(1);
    expect(incident.updates[0]!.message).toBe("We are looking into it");

    const history = services[0]!.recentHistory as Array<{ status: string }>;
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history.some((h) => h.status === "Outage")).toBe(true);
  });

  it("returns 404 for an unknown slug", async () => {
    const app = createApp({ config, prisma: p.prisma });
    const res = await request(app).get("/api/v1/public/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("hides an incident whose service is private even when the flag is true", async () => {
    // Add a second public service with no incident so the page still has content,
    // then confirm the private service's incident never leaks.
    const app = createApp({ config, prisma: p.prisma });
    const res = await request(app).get(`/api/v1/public/${slug}`);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("Private outage");
    expect(body).not.toContain(privateServiceId);
  });
});
