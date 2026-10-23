import { randomBytes } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { signAccessToken } from "../../src/auth/tokens";
import { loadConfig } from "../../src/config";
import { createTestDb, hasTestDb, prismaFor, type TestDb } from "../helpers/test-db";

const SECRET = "s".repeat(40);

describe.skipIf(!hasTestDb)("creating services, projects and members (plan limits, one code path)", () => {
  let t: TestDb;
  let p: ReturnType<typeof prismaFor>;
  let app: ReturnType<typeof createApp>;
  let ownerId: string;
  let bearer: string;
  let cookie: string;
  let n = 0;

  beforeAll(async () => {
    t = await createTestDb();
    p = prismaFor(t);
    const config = loadConfig({ DATABASE_URL: "postgres://unused", CREDENTIALS_ENC_KEY: randomBytes(32).toString("base64"), JWT_SECRET: SECRET } as NodeJS.ProcessEnv);
    app = createApp({ config, prisma: p.prisma, logStream: { write: () => {} } });
    ownerId = (await t.client.query(`INSERT INTO users (email, password_hash) VALUES ('owner@x.io', 'x') RETURNING id`)).rows[0].id;
    bearer = `Bearer ${signAccessToken(ownerId, SECRET, 900)}`;
    cookie = `sp_token=${signAccessToken(ownerId, SECRET, 900)}`;
  });
  afterAll(async () => {
    await p?.close();
    await t?.close();
  });

  async function newProject(plan: "free" | "pro" = "free") {
    n += 1;
    const id = (
      await t.client.query(`INSERT INTO projects (name, slug, plan_id) VALUES ($1, $1, (SELECT id FROM plans WHERE name = $2)) RETURNING id`, [`proj-${n}`, plan])
    ).rows[0].id as string;
    await t.client.query(`INSERT INTO memberships (project_id, user_id, role) VALUES ($1, $2, 'Owner')`, [id, ownerId]);
    return id;
  }
  const count = async (sql: string, args: unknown[]) => (await t.client.query(sql, args)).rows[0].n as number;
  const services = (project: string) => count(`SELECT count(*)::int AS n FROM services WHERE project_id = $1 AND deleted_at IS NULL`, [project]);
  const members = (project: string) => count(`SELECT count(*)::int AS n FROM memberships WHERE project_id = $1`, [project]);

  const apiCreate = (project: string, body: object = {}) =>
    request(app).post(`/api/v1/projects/${project}/services`).set("Authorization", bearer).send({ name: `svc-${++n}`, url: "https://example.com/health", intervalSeconds: 60, timeoutSeconds: 5, ...body });
  const uiCreate = (project: string, fields: Record<string, string | number>) =>
    request(app).post(`/app/projects/${project}/services`).set("Cookie", cookie).type("form").send(new URLSearchParams({ name: `ui-${++n}`, url: "https://example.com/health", intervalSeconds: "60", timeoutSeconds: "5", ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)])) }).toString());
  const invite = (project: string, email: string, role = "Viewer") =>
    request(app).post(`/api/v1/projects/${project}/members`).set("Authorization", bearer).send({ email, role });
  const user = async (email: string) => (await t.client.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [email])).rows[0].id as string;

  describe("service limit", () => {
    it("stops at the plan limit even when requests arrive together (API)", async () => {
      const project = await newProject("free"); // 3 services
      const codes = (await Promise.all(Array.from({ length: 10 }, () => apiCreate(project)))).map((r) => r.status).sort();
      expect(codes).toEqual([201, 201, 201, 409, 409, 409, 409, 409, 409, 409]);
      expect(await services(project)).toBe(3);
    });

    it("stops at the plan limit even when requests arrive together (browser)", async () => {
      const project = await newProject("free");
      await Promise.all(Array.from({ length: 10 }, () => uiCreate(project, {})));
      expect(await services(project)).toBe(3);
    });

    it("counts the API and the browser together", async () => {
      const project = await newProject("free");
      await Promise.all([apiCreate(project), uiCreate(project, {}), apiCreate(project), uiCreate(project, {}), apiCreate(project), uiCreate(project, {})]);
      expect(await services(project)).toBe(3);
    });

    it("explains the refusal and lifts it on the pro plan", async () => {
      const project = await newProject("free");
      for (let i = 0; i < 3; i += 1) expect((await apiCreate(project)).status).toBe(201);
      const refused = await apiCreate(project);
      expect(refused.status).toBe(409);
      expect(refused.body.error.message).toMatch(/Plan limit reached: free allows 3 services/);
      const page = await request(app).post(`/app/projects/${project}/services`).set("Cookie", cookie).type("form").send("name=x&url=https%3A%2F%2Fexample.com&intervalSeconds=60&timeoutSeconds=5");
      expect(page.headers.location).toBe(`/app/projects/${project}?error=limit`);
      const shown = await request(app).get(page.headers.location!).set("Cookie", cookie);
      expect(shown.text).toContain("service limit is reached");

      const upgrade = await request(app).post(`/api/v1/projects/${project}/plan`).set({ Authorization: bearer, "Idempotency-Key": "lift-limit-0001" }).send({ planName: "pro" });
      expect(upgrade.status).toBe(201);
      expect((await apiCreate(project)).status).toBe(201);
    });

    it("does not count a deleted service", async () => {
      const project = await newProject("free");
      for (let i = 0; i < 3; i += 1) await apiCreate(project);
      await t.client.query(`UPDATE services SET deleted_at = now() WHERE id = (SELECT id FROM services WHERE project_id = $1 LIMIT 1)`, [project]);
      expect((await apiCreate(project)).status).toBe(201);
    });
  });

  describe("the browser form applies the same rules as the API", () => {
    it("refuses addresses the API refuses and saves nothing", async () => {
      const project = await newProject("pro");
      for (const url of ["http://169.254.169.254/latest/meta-data", "http://localhost:5432", "http://10.0.0.5/x", "http://127.0.0.1", "ftp://example.com/x"]) {
        const res = await uiCreate(project, { url });
        expect(res.status, url).toBe(302);
        expect(res.headers.location, url).toBe(`/app/projects/${project}?error=url`);
      }
      expect(await services(project)).toBe(0);
      const shown = await request(app).get(`/app/projects/${project}?error=url`).set("Cookie", cookie);
      expect(shown.text).toContain("localhost and private networks are refused");
    });

    it("answers a bad interval or timeout with a message, not a server error", async () => {
      const project = await newProject("pro");
      const interval = await uiCreate(project, { intervalSeconds: 1 });
      expect(interval.status).toBe(302);
      expect(interval.headers.location).toBe(`/app/projects/${project}?error=interval`);
      const timeout = await uiCreate(project, { intervalSeconds: 30, timeoutSeconds: 30 });
      expect(timeout.headers.location).toBe(`/app/projects/${project}?error=timeout`);
      expect((await uiCreate(project, { intervalSeconds: "abc" })).status).toBe(302);
      expect(await services(project)).toBe(0);
    });

    it("writes configuration version 1 and the audit row, like the API", async () => {
      const project = await newProject("pro");
      expect((await uiCreate(project, { name: "From browser" })).headers.location).toBe(`/app/projects/${project}`);
      const service = (await t.client.query(`SELECT id, version FROM services WHERE project_id = $1`, [project])).rows[0];
      expect(service.version).toBe(1);
      expect(await count(`SELECT count(*)::int AS n FROM service_config_versions WHERE service_id = $1 AND version = 1`, [service.id])).toBe(1);
      expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'service.created'`, [service.id])).toBe(1);
      const versions = await request(app).get(`/api/v1/projects/${project}/services/${service.id}/versions`).set("Authorization", bearer);
      expect(versions.body.versions).toHaveLength(1);
    });

    it("lets only an owner create a service from the browser", async () => {
      const project = await newProject("pro");
      const viewer = await user("viewer@x.io");
      await t.client.query(`INSERT INTO memberships (project_id, user_id, role) VALUES ($1, $2, 'Viewer')`, [project, viewer]);
      const res = await request(app).post(`/app/projects/${project}/services`).set("Cookie", `sp_token=${signAccessToken(viewer, SECRET, 900)}`).type("form").send("name=x&url=https%3A%2F%2Fexample.com&intervalSeconds=60&timeoutSeconds=5");
      expect(res.status).toBe(302);
      expect(await services(project)).toBe(0);
    });
  });

  describe("project creation", () => {
    const uiProject = (fields: string) => request(app).post("/app/projects").set("Cookie", cookie).type("form").send(fields);

    it("refuses a slug the API refuses, instead of saving it", async () => {
      for (const slug of ["My Project!!", "a", "-lead", "trail-", "UPPER_case", "a".repeat(65)]) {
        const res = await uiProject(`name=Thing&slug=${encodeURIComponent(slug)}`);
        expect(res.status, slug).toBe(400);
        expect(res.text, slug).toContain("Slug must be 2 to 64 lowercase letters");
      }
      expect(await count(`SELECT count(*)::int AS n FROM projects WHERE name = 'Thing'`, [])).toBe(0);
    });

    it("derives a valid slug from the name and writes the audit row", async () => {
      const res = await uiProject("name=Acme%20Status%20Page&slug=");
      expect(res.status).toBe(302);
      const project = (await t.client.query(`SELECT id, slug FROM projects WHERE name = 'Acme Status Page'`)).rows[0];
      expect(project.slug).toBe("acme-status-page");
      expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE project_id = $1 AND action = 'project.created'`, [project.id])).toBe(1);
      expect(await count(`SELECT count(*)::int AS n FROM memberships WHERE project_id = $1 AND role = 'Owner'`, [project.id])).toBe(1);
    });

    it("answers a taken slug with a message, also for two requests at once", async () => {
      const results = await Promise.all([1, 2, 3].map(() => uiProject("name=Same&slug=same-slug")));
      expect(results.map((r) => r.status).sort()).toEqual([302, 409, 409]);
      expect(await count(`SELECT count(*)::int AS n FROM projects WHERE slug = 'same-slug'`, [])).toBe(1);
    });
  });

  describe("member limit", () => {
    it("stops at the plan limit even when invitations arrive together", async () => {
      const project = await newProject("free"); // 3 members, the owner is one
      const emails: string[] = [];
      for (let i = 0; i < 8; i += 1) {
        const e = `race${n}-${i}@x.io`;
        await user(e);
        emails.push(e);
      }
      const codes = (await Promise.all(emails.map((e) => invite(project, e)))).map((r) => r.status).sort();
      expect(codes).toEqual([201, 201, 409, 409, 409, 409, 409, 409]);
      expect(await members(project)).toBe(3);
    });

    it("reports an existing member as one, even when the project is full", async () => {
      const project = await newProject("free");
      const a = await user(`a${n}@x.io`);
      const b = await user(`b${n}@x.io`);
      await t.client.query(`INSERT INTO memberships (project_id, user_id, role) VALUES ($1, $2, 'Viewer'), ($1, $3, 'Viewer')`, [project, a, b]);
      const res = await invite(project, `a${n}@x.io`);
      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe("User is already a member");
      const full = await invite(project, (await (async () => { const e = `c${n}@x.io`; await user(e); return e; })()));
      expect(full.body.error.message).toMatch(/Plan limit reached: free allows 3 members/);
    });

    it("lets a pro project hold more, and audits the invitation", async () => {
      const project = await newProject("pro");
      const email = `pro${n}@x.io`;
      const id = await user(email);
      expect((await invite(project, email)).status).toBe(201);
      expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE project_id = $1 AND action = 'member.invited' AND entity_id = $2`, [project, id])).toBe(1);
    });
  });

  describe("changing plan", () => {
    const setPlan = (project: string, planName: string, key: string) =>
      request(app).post(`/api/v1/projects/${project}/plan`).set({ Authorization: bearer, "Idempotency-Key": key }).send({ planName });
    const planOf = async (project: string) => (await t.client.query(`SELECT pl.name FROM projects p JOIN plans pl ON pl.id = p.plan_id WHERE p.id = $1`, [project])).rows[0].name as string;

    it("refuses a plan that is smaller than what the project already has", async () => {
      const project = await newProject("pro");
      for (let i = 0; i < 5; i += 1) await t.client.query(`INSERT INTO services (project_id, name, url, interval_seconds, timeout_seconds) VALUES ($1, $2, 'https://example.com', 60, 5)`, [project, `s${i}`]);
      const res = await setPlan(project, "free", "downgrade-00001");
      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain("5 services");
      expect(await planOf(project)).toBe("pro");
      expect(await count(`SELECT count(*)::int AS n FROM payment_attempts WHERE project_id = $1`, [project])).toBe(0);
      expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE project_id = $1 AND action = 'plan.upgraded'`, [project])).toBe(0);
    });

    it("allows the change once the project fits, with the same key", async () => {
      const project = await newProject("pro");
      for (let i = 0; i < 5; i += 1) await t.client.query(`INSERT INTO services (project_id, name, url, interval_seconds, timeout_seconds) VALUES ($1, $2, 'https://example.com', 60, 5)`, [project, `s${i}`]);
      expect((await setPlan(project, "free", "downgrade-00002")).status).toBe(409);
      await t.client.query(`UPDATE services SET deleted_at = now() WHERE project_id = $1 AND name IN ('s0', 's1', 's2')`, [project]);
      expect((await setPlan(project, "free", "downgrade-00002")).status).toBe(201);
      expect(await planOf(project)).toBe("free");
    });

    it("counts members as well as services", async () => {
      const project = await newProject("pro");
      for (let i = 0; i < 3; i += 1) {
        const id = await user(`dg${n}-${i}@x.io`);
        await t.client.query(`INSERT INTO memberships (project_id, user_id, role) VALUES ($1, $2, 'Viewer')`, [project, id]);
      }
      const res = await setPlan(project, "free", "downgrade-00003");
      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain("4 members");
    });

    it("cannot be raced past by a creation at the same moment", async () => {
      const project = await newProject("pro");
      for (let i = 0; i < 3; i += 1) await t.client.query(`INSERT INTO services (project_id, name, url, interval_seconds, timeout_seconds) VALUES ($1, $2, 'https://example.com', 60, 5)`, [project, `s${i}`]);
      await Promise.all([setPlan(project, "free", "downgrade-00004"), apiCreate(project), apiCreate(project)]);
      const plan = await planOf(project);
      const total = await services(project);
      // Whichever order the requests were served in, the project never holds more than its plan allows.
      expect(plan === "free" ? total <= 3 : true).toBe(true);
    });
  });
});
