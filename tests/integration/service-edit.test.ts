import { randomBytes } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { signAccessToken } from "../../src/auth/tokens";
import { loadConfig } from "../../src/config";
import { decryptSecret } from "../../src/core/secrets";
import {
  createTestDb,
  hasTestDb,
  prismaFor,
  type TestDb,
} from "../helpers/test-db";

const SECRET = "s".repeat(40);
const KEY = randomBytes(32).toString("base64");

describe.skipIf(!hasTestDb)("editing a service (SP-02.4, SP-02.8)", () => {
  let t: TestDb;
  let p: ReturnType<typeof prismaFor>;
  let app: ReturnType<typeof createApp>;
  let projectId: string;
  let otherProjectId: string;
  type Who = "owner" | "responder" | "viewer" | "outsider";
  let ids: Record<Who, string>;
  let token: Record<Who, string>;
  let n = 0;

  beforeAll(async () => {
    t = await createTestDb();
    p = prismaFor(t);
    const config = loadConfig({
      DATABASE_URL: "postgres://unused",
      CREDENTIALS_ENC_KEY: KEY,
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
    const project = async (slug: string) =>
      (
        await t.client.query(
          `INSERT INTO projects (name, slug) VALUES ($1, $1) RETURNING id`,
          [slug],
        )
      ).rows[0].id as string;
    projectId = await project("p");
    otherProjectId = await project("q");
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
    await t.client.query(
      `INSERT INTO memberships (project_id, user_id, role) VALUES ($1, $2, 'Owner')`,
      [otherProjectId, ids.owner],
    );
  });
  afterAll(async () => {
    await p?.close();
    await t?.close();
  });

  const as = (who: Who) => ({ Authorization: `Bearer ${token[who]}` });
  const base = (id: string, project = projectId) =>
    `/projects/${project}/services/${id}`;

  // Services are made through the real create endpoint, so version 1 exists the way it does in production.
  async function newService(extra: object = {}, project = projectId) {
    n += 1;
    const res = await request(app)
      .post(`/projects/${project}/services`)
      .set(as("owner"))
      .send({
        name: `svc-${n}`,
        url: "https://example.com/health",
        intervalSeconds: 60,
        timeoutSeconds: 5,
        expectedBodyText: "ok",
        degradedMs: 800,
        ...extra,
      });
    expect(res.status).toBe(201);
    return res.body.service.id as string;
  }
  const patch = (id: string, who: Who, body: object, project = projectId) =>
    request(app).patch(base(id, project)).set(as(who)).send(body);
  const versions = async (id: string) =>
    (
      await t.client.query(
        `SELECT version, snapshot, actor_user_id FROM service_config_versions WHERE service_id = $1 ORDER BY version`,
        [id],
      )
    ).rows;
  const audit = async (id: string) =>
    (
      await t.client.query(
        `SELECT details FROM audit_log WHERE entity_id = $1 AND action = 'service.updated'`,
        [id],
      )
    ).rows;

  it("changes only the fields sent, bumps the version and records who changed what", async () => {
    const id = await newService();
    const res = await patch(id, "owner", { name: "renamed", failThreshold: 5 });
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual(["name", "failThreshold"]);
    expect(res.body.service).toMatchObject({
      name: "renamed",
      failThreshold: 5,
      url: "https://example.com/health",
      intervalSeconds: 60,
      expectedBodyText: "ok",
      degradedMs: 800,
      version: 2,
    });
    const v = await versions(id);
    expect(v.map((r) => r.version)).toEqual([1, 2]);
    expect(v[1].actor_user_id).toBe(ids.owner);
    expect(v[1].snapshot).toMatchObject({
      name: "renamed",
      failThreshold: 5,
      url: "https://example.com/health",
    });
    expect(v[0].snapshot.name).toMatch(/^svc-/);
    expect((await audit(id))[0].details).toEqual({
      version: 2,
      changed: ["name", "failThreshold"],
    });
  });

  it("creates no version when nothing actually changes", async () => {
    const id = await newService();
    const res = await patch(id, "owner", {
      name: `svc-${n}`,
      intervalSeconds: 60,
      expectedStatusCodes: [200],
    });
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual([]);
    expect(res.body.service.version).toBe(1);
    expect(await versions(id)).toHaveLength(1);
    expect(await audit(id)).toHaveLength(0);
  });

  it("validates the merged configuration as a whole, not the fields sent", async () => {
    const id = await newService(); // interval 60, timeout 5
    const lowerInterval = await patch(id, "owner", {
      intervalSeconds: 30,
      timeoutSeconds: 30,
    });
    expect(lowerInterval.status).toBe(422);
    expect(lowerInterval.body.error.details).toEqual([
      { path: "timeoutSeconds", message: "must be less than intervalSeconds" },
    ]);
    // The timeout is not in the body, yet shrinking the interval below it is still refused.
    await patch(id, "owner", { intervalSeconds: 120, timeoutSeconds: 100 });
    const squeeze = await patch(id, "owner", { intervalSeconds: 60 });
    expect(squeeze.status).toBe(422);
    expect(squeeze.body.error.details[0].path).toBe("timeoutSeconds");
    // Both together are fine.
    expect(
      (await patch(id, "owner", { intervalSeconds: 60, timeoutSeconds: 10 }))
        .status,
    ).toBe(200);
    expect((await versions(id)).map((r) => r.version)).toEqual([1, 2, 3]);
  });

  it("refuses unsafe addresses, bad values, unknown fields and an empty body, and changes nothing", async () => {
    const id = await newService();
    for (const body of [
      { url: "http://localhost:3000" },
      { url: "http://10.0.0.5/x" },
      { url: "ftp://example.com" },
      { intervalSeconds: 45 },
      { method: "DELETE" },
      { failThreshold: 0 },
      { expectedStatusCodes: [] },
      { enabled: false },
      { version: 9 },
      {},
    ]) {
      const res = await patch(id, "owner", body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    const row = await t.client.query(
      `SELECT version, url, enabled FROM services WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]).toMatchObject({
      version: 1,
      url: "https://example.com/health",
      enabled: true,
    });
    expect(await versions(id)).toHaveLength(1);
  });

  it("clears optional fields with null", async () => {
    const id = await newService();
    const res = await patch(id, "owner", {
      expectedBodyText: null,
      degradedMs: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.service).toMatchObject({
      expectedBodyText: null,
      degradedMs: null,
      version: 2,
    });
    expect(res.body.changed).toEqual(["expectedBodyText", "degradedMs"]);
  });

  it("encrypts replaced credentials, removes them on null, and never returns them", async () => {
    const id = await newService();
    const stored = async () =>
      (
        await t.client.query(
          `SELECT credentials_enc FROM services WHERE id = $1`,
          [id],
        )
      ).rows[0].credentials_enc as Buffer | null;
    const set = await patch(id, "owner", {
      credentials: "Bearer top-secret-token",
    });
    expect(set.status).toBe(200);
    expect(JSON.stringify(set.body)).not.toContain("top-secret-token");
    const blob = await stored();
    expect(blob).not.toBeNull();
    expect(blob!.toString("utf8")).not.toContain("top-secret-token");
    expect(decryptSecret(blob!, KEY)).toBe("Bearer top-secret-token");
    const v = await versions(id);
    expect(JSON.stringify(v[1].snapshot)).not.toContain("top-secret-token");
    expect(v[1].snapshot.hasCredentials).toBe(true);
    expect(JSON.stringify(await audit(id))).not.toContain("top-secret-token");

    const removed = await patch(id, "owner", { credentials: null });
    expect(removed.body.changed).toEqual(["credentials"]);
    expect(await stored()).toBeNull();
    // Removing what is not there is not a change.
    expect(
      (await patch(id, "owner", { credentials: null })).body.changed,
    ).toEqual([]);
  });

  // A service that looks healthy but already has `failures` failed results after its last transition, so only the
  // thresholds decide whether it is an outage.
  async function healthyWithFailures(failures: number) {
    const id = await newService();
    await t.client.query(
      `UPDATE services SET current_status = 'Operational', computed_status = 'Operational',
              computed_since = now() - interval '1 hour', status_since = now() - interval '1 hour', last_result_at = now()
        WHERE id = $1`,
      [id],
    );
    for (let i = 0; i < failures; i += 1) {
      const job = (
        await t.client.query(
          `INSERT INTO check_jobs (service_id, scheduled_for, status) VALUES ($1, now() - ($2 || ' minutes')::interval, 'done') RETURNING id`,
          [id, String(failures - i)],
        )
      ).rows[0].id as string;
      await t.client.query(
        `INSERT INTO check_results (job_id, service_id, passed, failure_reason, config_version, checked_at)
         VALUES ($1, $2, false, 'timeout', 1, now() - ($3 || ' minutes')::interval)`,
        [job, id, String(failures - i)],
      );
    }
    return id;
  }
  const incidentsOf = async (id: string) =>
    (
      await t.client.query(
        `SELECT origin, status FROM incidents WHERE service_id = $1`,
        [id],
      )
    ).rows;
  const historyOf = async (id: string) =>
    (
      await t.client.query(
        `SELECT status, source FROM service_status_history WHERE service_id = $1`,
        [id],
      )
    ).rows;

  it("recalculates the status at once when a threshold change decides the outcome", async () => {
    const id = await healthyWithFailures(2); // two failures, threshold 3: still Operational
    const res = await patch(id, "owner", { failThreshold: 2 });
    expect(res.status).toBe(200);
    expect(res.body.service.currentStatus).toBe("Outage");
    expect(await incidentsOf(id)).toEqual([
      { origin: "auto", status: "Investigating" },
    ]);
    expect(await historyOf(id)).toHaveLength(1);
  });

  it("does not clear an outage when a threshold is raised", async () => {
    const id = await healthyWithFailures(2);
    await patch(id, "owner", { failThreshold: 2 });
    const raised = await patch(id, "owner", { failThreshold: 5 });
    expect(raised.body.service.currentStatus).toBe("Outage"); // an outage is left only by passing results
    expect(await incidentsOf(id)).toHaveLength(1);
  });

  it("opens no incident while an override is active", async () => {
    const id = await healthyWithFailures(2);
    await t.client.query(
      `INSERT INTO status_overrides (service_id, status, reason, actor_user_id, expires_at) VALUES ($1, 'Operational', 'maintenance', $2, now() + interval '1 hour')`,
      [id, ids.owner],
    );
    const res = await patch(id, "owner", { failThreshold: 2 });
    expect(res.status).toBe(200);
    expect(res.body.service.currentStatus).toBe("Operational");
    expect(await incidentsOf(id)).toHaveLength(0);
    const computed = await t.client.query(
      `SELECT computed_status FROM services WHERE id = $1`,
      [id],
    );
    expect(computed.rows[0].computed_status).toBe("Outage");
  });

  it("leaves the status and history alone when the edit does not change the outcome", async () => {
    const id = await healthyWithFailures(2);
    const res = await patch(id, "owner", {
      name: "renamed",
      url: "https://example.org/health",
    });
    expect(res.status).toBe(200);
    expect(res.body.service.currentStatus).toBe("Operational");
    expect(await historyOf(id)).toHaveLength(0);
    expect(await incidentsOf(id)).toHaveLength(0);
  });

  it("keeps a disabled service disabled and Unknown", async () => {
    const id = await newService();
    await t.client.query(`UPDATE services SET enabled = false WHERE id = $1`, [
      id,
    ]);
    const res = await patch(id, "owner", { name: "still off" });
    expect(res.status).toBe(200);
    expect(res.body.service).toMatchObject({
      enabled: false,
      currentStatus: "Unknown",
    });
  });

  it("is for owners only and stays inside the project", async () => {
    const id = await newService();
    expect((await patch(id, "responder", { name: "x" })).status).toBe(403);
    expect((await patch(id, "viewer", { name: "x" })).status).toBe(403);
    expect((await patch(id, "outsider", { name: "x" })).status).toBe(404);
    expect(
      (await request(app).patch(base(id)).send({ name: "x" })).status,
    ).toBe(401);
    const foreign = await newService({}, otherProjectId);
    expect((await patch(foreign, "owner", { name: "x" })).status).toBe(404);
    expect(
      (await patch(foreign, "owner", { name: "x" }, otherProjectId)).status,
    ).toBe(200);
    expect((await patch("not-a-uuid", "owner", { name: "x" })).status).toBe(
      404,
    );
    await t.client.query(
      `UPDATE services SET deleted_at = now() WHERE id = $1`,
      [id],
    );
    expect((await patch(id, "owner", { name: "x" })).status).toBe(404);
  });

  it("gives simultaneous edits consecutive versions with no lost update", async () => {
    const id = await newService();
    const results = await Promise.all([
      patch(id, "owner", { failThreshold: 4 }),
      patch(id, "owner", { recoveryThreshold: 4 }),
      patch(id, "owner", { slowThreshold: 4 }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await versions(id)).map((r) => r.version)).toEqual([1, 2, 3, 4]);
    const row = await t.client.query(
      `SELECT version, fail_threshold, recovery_threshold, slow_threshold FROM services WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]).toEqual({
      version: 4,
      fail_threshold: 4,
      recovery_threshold: 4,
      slow_threshold: 4,
    });
  });

  it("lists the version history for owners, newest first", async () => {
    const id = await newService();
    await patch(id, "owner", { name: "second" });
    const res = await request(app)
      .get(`${base(id)}/versions`)
      .set(as("owner"));
    expect(res.status).toBe(200);
    expect(
      res.body.versions.map((v: { version: number }) => v.version),
    ).toEqual([2, 1]);
    expect(res.body.versions[0].snapshot.name).toBe("second");
    expect(
      (
        await request(app)
          .get(`${base(id)}/versions`)
          .set(as("responder"))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get(`${base(id)}/versions`)
          .set(as("outsider"))
      ).status,
    ).toBe(404);
  });
});
