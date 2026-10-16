import { randomBytes } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { signAccessToken } from "../../src/auth/tokens";
import { loadConfig } from "../../src/config";
import {
  createTestDb,
  hasTestDb,
  prismaFor,
  type TestDb,
} from "../helpers/test-db";

const SECRET = "s".repeat(40);

describe.skipIf(!hasTestDb)("incidents endpoints (SP-05)", () => {
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
    const project = async (slug: string) =>
      (
        await t.client.query(
          `INSERT INTO projects (name, slug) VALUES ($1, $1) RETURNING id`,
          [slug],
        )
      ).rows[0].id as string;
      await t.client.query(
        `UPDATE projects SET plan_id = (SELECT id FROM plans WHERE name = 'pro') WHERE id = $1`,
        [projectId],
      );

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
  });
  afterAll(async () => {
    await p?.close();
    await t?.close();
  });

  const as = (who: Who) => ({ Authorization: `Bearer ${token[who]}` });
  const url = (path = "", project = projectId) =>
    `/api/v1/projects/${project}/incidents${path}`;

  async function newService(isPublic = true, project = projectId) {
    n += 1;
    return (
      await t.client.query(
        `INSERT INTO services (project_id, name, url, interval_seconds, timeout_seconds, is_public)
         VALUES ($1, $2, 'https://example.com', 60, 5, $3) RETURNING id`,
        [project, `svc-${n}`, isPublic],
      )
    ).rows[0].id as string;
  }
  async function newIncident(
    o: {
      service?: string;
      status?: string;
      isPublic?: boolean;
      project?: string;
      createdAt?: string;
    } = {},
  ) {
    const status = o.status ?? "Investigating";
    const service = o.service ?? (await newService(true, o.project));
    return (
      await t.client.query(
        `INSERT INTO incidents (project_id, service_id, title, status, origin, is_public, resolved_at, created_at)
         VALUES ($1, $2, 'down', $3, 'auto', $4, CASE WHEN $3 = 'Resolved' THEN now() END, COALESCE($5::timestamptz, now()))
         RETURNING id`,
        [
          o.project ?? projectId,
          service,
          status,
          o.isPublic ?? true,
          o.createdAt ?? null,
        ],
      )
    ).rows[0].id as string;
  }
  const audit = async (id: string, action: string) =>
    (
      await t.client.query(
        `SELECT actor_user_id FROM audit_log WHERE entity_id = $1 AND action = $2`,
        [id, action],
      )
    ).rows;
  const post = (path: string, who: Who, body: object) =>
    request(app).post(url(path)).set(as(who)).send(body);

  describe("list and view", () => {
    it("lists a project's incidents newest first and filters by state and service", async () => {
      const project = (
        await t.client.query(
          `INSERT INTO projects (name, slug) VALUES ('l', 'l') RETURNING id`,
        )
      ).rows[0].id as string;
      await t.client.query(
        `INSERT INTO memberships (project_id, user_id, role) VALUES ($1, $2, 'Viewer')`,
        [project, ids.viewer],
      );
      const svc = await newService(true, project);
      const old = await newIncident({
        project,
        service: svc,
        status: "Resolved",
        createdAt: "2026-01-01T00:00:00Z",
      });
      const open = await newIncident({ project, service: svc });
      await newIncident({ project: otherProjectId });

      const all = await request(app).get(url("", project)).set(as("viewer"));
      expect(all.status).toBe(200);
      expect(all.body.incidents.map((i: { id: string }) => i.id)).toEqual([
        open,
        old,
      ]);
      const active = await request(app)
        .get(url("?state=active", project))
        .set(as("viewer"));
      expect(active.body.incidents.map((i: { id: string }) => i.id)).toEqual([
        open,
      ]);
      const resolved = await request(app)
        .get(url("?state=resolved", project))
        .set(as("viewer"));
      expect(resolved.body.incidents.map((i: { id: string }) => i.id)).toEqual([
        old,
      ]);
      const bad = await request(app)
        .get(url("?state=nope", project))
        .set(as("viewer"));
      expect(bad.status).toBe(422);
    });

    it("shows the derived visibility, never the stored flag", async () => {
      const privateSvc = await newService(false);
      const id = await newIncident({ service: privateSvc, isPublic: true });
      const res = await request(app)
        .get(url(`/${id}`))
        .set(as("viewer"));
      expect(res.status).toBe(200);
      expect(res.body.incident.isPublic).toBe(false);
    });

    it("refuses outsiders and anonymous callers and hides incidents of other projects", async () => {
      const id = await newIncident();
      expect(
        (
          await request(app)
            .get(url(`/${id}`))
            .set(as("outsider"))
        ).status,
      ).toBe(404);
      expect((await request(app).get(url(`/${id}`))).status).toBe(401);
      const foreign = await newIncident({ project: otherProjectId });
      expect(
        (
          await request(app)
            .get(url(`/${foreign}`))
            .set(as("owner"))
        ).status,
      ).toBe(404);
      expect(
        (await request(app).get(url("/not-a-uuid")).set(as("owner"))).status,
      ).toBe(404);
    });
  });

  describe("open manually (SP-05.1, SP-05.2)", () => {
    it("lets a responder open one that follows the service's visibility", async () => {
      const pub = await newService(true);
      const priv = await newService(false);
      const a = await post("", "responder", {
        serviceId: pub,
        title: "Checkout slow",
      });
      expect(a.status).toBe(201);
      expect(a.body.incident).toMatchObject({
        status: "Investigating",
        origin: "manual",
        isPublic: true,
        openedByUserId: ids.responder,
      });
      const b = await post("", "owner", {
        serviceId: priv,
        title: "Private issue",
      });
      expect(b.status).toBe(201);
      expect(b.body.incident.isPublic).toBe(false);
      expect(await audit(a.body.incident.id, "incident.opened")).toHaveLength(
        1,
      );
    });

    it("answers 409 while one is active, and allows a new one after it resolves", async () => {
      const svc = await newService();
      const first = await post("", "responder", {
        serviceId: svc,
        title: "first",
      });
      expect(
        (await post("", "owner", { serviceId: svc, title: "second" })).status,
      ).toBe(409);
      await t.client.query(
        `UPDATE incidents SET status = 'Resolved', resolved_at = now() WHERE id = $1`,
        [first.body.incident.id],
      );
      expect(
        (await post("", "owner", { serviceId: svc, title: "second" })).status,
      ).toBe(201);
    });

    it("answers 409 for exactly one of two simultaneous requests", async () => {
      const svc = await newService();
      const codes = (
        await Promise.all([
          post("", "responder", { serviceId: svc, title: "race a" }),
          post("", "owner", { serviceId: svc, title: "race b" }),
        ])
      )
        .map((r) => r.status)
        .sort();
      expect(codes).toEqual([201, 409]);
    });

    it("refuses viewers, foreign services and invalid bodies", async () => {
      const svc = await newService();
      expect(
        (await post("", "viewer", { serviceId: svc, title: "abc" })).status,
      ).toBe(403);
      expect(
        (await post("", "outsider", { serviceId: svc, title: "abc" })).status,
      ).toBe(404);
      const foreign = await newService(true, otherProjectId);
      expect(
        (await post("", "owner", { serviceId: foreign, title: "abc" })).status,
      ).toBe(404);
      expect(
        (await post("", "owner", { serviceId: svc, title: "ab" })).status,
      ).toBe(422);
      expect(
        (await post("", "owner", { serviceId: "x", title: "abc" })).status,
      ).toBe(422);
    });
  });

  describe("updates and transitions (SP-05.3, SP-05.4, SP-05.6)", () => {
    it("moves forward one status at a time, recording who and when", async () => {
      const id = await newIncident();
      for (const status of ["Identified", "Monitoring", "Resolved"]) {
        const res = await post(`/${id}/updates`, "responder", {
          status,
          message: `now ${status}`,
          isPublic: true,
        });
        expect(res.status).toBe(201);
        expect(res.body.incident.status).toBe(status);
      }
      const view = await request(app)
        .get(url(`/${id}`))
        .set(as("viewer"));
      expect(
        view.body.incident.updates.map((u: { status: string }) => u.status),
      ).toEqual(["Identified", "Monitoring", "Resolved"]);
      expect(view.body.incident.updates[0].actorUserId).toBe(ids.responder);
      expect(view.body.incident.resolvedByUserId).toBe(ids.responder);
      expect(view.body.incident.resolvedAt).not.toBeNull();
    });

    it("answers 409 for skipping, going back and repeating a move", async () => {
      const id = await newIncident();
      const skip = await post(`/${id}/updates`, "responder", {
        status: "Resolved",
        message: "x",
      });
      expect(skip.status).toBe(409);
      expect(skip.body.error.message).toContain("Identified");
      await post(`/${id}/updates`, "responder", {
        status: "Identified",
        message: "x",
      });
      expect(
        (
          await post(`/${id}/updates`, "responder", {
            status: "Investigating",
            message: "x",
          })
        ).status,
      ).toBe(409);
      const rows = await t.client.query(
        `SELECT status FROM incidents WHERE id = $1`,
        [id],
      );
      expect(rows.rows[0].status).toBe("Identified");
    });

    it("adds a note without moving the incident", async () => {
      const id = await newIncident();
      const res = await post(`/${id}/updates`, "responder", {
        message: "looking into it",
      });
      expect(res.status).toBe(201);
      expect(res.body.incident.status).toBe("Investigating");
      expect(res.body.incident.updates[0]).toMatchObject({
        status: "Investigating",
        isPublic: false,
      });
      const same = await post(`/${id}/updates`, "responder", {
        status: "Investigating",
        message: "still on it",
      });
      expect(same.status).toBe(409);
    });

    it("closes an incident once resolved", async () => {
      const id = await newIncident({ status: "Resolved" });
      expect(
        (await post(`/${id}/updates`, "owner", { message: "late note" }))
          .status,
      ).toBe(409);
    });

    it("lets the owner resolve too, and refuses viewers", async () => {
      const id = await newIncident({ status: "Monitoring" });
      expect(
        (
          await post(`/${id}/updates`, "viewer", {
            status: "Resolved",
            message: "x",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await post(`/${id}/updates`, "owner", {
            status: "Resolved",
            message: "fixed",
          })
        ).status,
      ).toBe(201);
    });

    it("never makes an update public when the incident is not", async () => {
      const hidden = await newIncident({ isPublic: false });
      const a = await post(`/${hidden}/updates`, "responder", {
        message: "x",
        isPublic: true,
      });
      expect(a.body.incident.updates[0].isPublic).toBe(false);
      const privSvc = await newService(false);
      const onPrivate = await newIncident({ service: privSvc, isPublic: true });
      const b = await post(`/${onPrivate}/updates`, "responder", {
        message: "x",
        isPublic: true,
      });
      expect(b.body.incident.updates[0].isPublic).toBe(false);
      const visible = await newIncident();
      const c = await post(`/${visible}/updates`, "responder", {
        message: "x",
        isPublic: true,
      });
      expect(c.body.incident.updates[0].isPublic).toBe(true);
    });

    it("validates the message and answers 404 for incidents of other projects", async () => {
      const id = await newIncident();
      expect(
        (await post(`/${id}/updates`, "responder", { message: "  " })).status,
      ).toBe(422);
      expect(
        (
          await post(`/${id}/updates`, "responder", {
            status: "Done",
            message: "x",
          })
        ).status,
      ).toBe(422);
      const foreign = await newIncident({ project: otherProjectId });
      expect(
        (await post(`/${foreign}/updates`, "owner", { message: "x" })).status,
      ).toBe(404);
    });

    it("lets exactly one of two simultaneous moves win", async () => {
      const id = await newIncident();
      const codes = (
        await Promise.all([
          post(`/${id}/updates`, "responder", {
            status: "Identified",
            message: "a",
          }),
          post(`/${id}/updates`, "owner", {
            status: "Identified",
            message: "b",
          }),
        ])
      )
        .map((r) => r.status)
        .sort();
      expect(codes).toEqual([201, 409]);
    });

    it("records the change in the audit log", async () => {
      const id = await newIncident();
      await post(`/${id}/updates`, "responder", {
        status: "Identified",
        message: "x",
      });
      await post(`/${id}/updates`, "responder", { message: "note" });
      expect(await audit(id, "incident.status_changed")).toHaveLength(1);
      expect(await audit(id, "incident.noted")).toHaveLength(1);
    });
  });

  describe("hide (SP-05.5)", () => {
    it("lets only the owner hide an incident, and hides its updates with it", async () => {
      const id = await newIncident();
      await post(`/${id}/updates`, "responder", {
        message: "public note",
        isPublic: true,
      });
      expect((await post(`/${id}/hide`, "responder", {})).status).toBe(403);
      expect((await post(`/${id}/hide`, "outsider", {})).status).toBe(404);
      const res = await post(`/${id}/hide`, "owner", {});
      expect(res.status).toBe(200);
      expect(res.body.incident.isPublic).toBe(false);
      const view = await request(app)
        .get(url(`/${id}`))
        .set(as("viewer"));
      expect(view.body.incident.updates[0].isPublic).toBe(false);
      expect(await audit(id, "incident.hidden")).toHaveLength(1);
    });

    it("is one-way: a repeat changes nothing and no request can publish it again", async () => {
      const id = await newIncident();
      await post(`/${id}/hide`, "owner", {});
      const again = await post(`/${id}/hide`, "owner", { isPublic: true });
      expect(again.status).toBe(200);
      expect(again.body.incident.isPublic).toBe(false);
      expect(await audit(id, "incident.hidden")).toHaveLength(1);
      const patch = await request(app)
        .patch(url(`/${id}`))
        .set(as("owner"))
        .send({ isPublic: true });
      expect(patch.status).toBe(404);
      const stored = await t.client.query(
        `SELECT is_public FROM incidents WHERE id = $1`,
        [id],
      );
      expect(stored.rows[0].is_public).toBe(false);
    });

    it("answers 404 for an incident of another project", async () => {
      const foreign = await newIncident({ project: otherProjectId });
      expect((await post(`/${foreign}/hide`, "owner", {})).status).toBe(404);
    });
  });
});
