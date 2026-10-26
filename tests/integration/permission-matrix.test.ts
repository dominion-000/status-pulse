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

/**
 * SP-TRQ5 — permission matrix over every authenticated API route.
 *
 * Rules (docs/stories.md cross-cutting):
 * - no token → 401
 * - non-member of the project → 404 (not 403)
 * - member whose role is too low → 403
 * - admin routes: non-admin → 403
 *
 * Public and auth routes are exercised only for the unauthenticated path.
 */

const SECRET = "s".repeat(40);

type Role = "Owner" | "Responder" | "Viewer";

interface Fixture {
  projectId: string;
  serviceId: string;
  incidentId: string;
  alertId: string;
  slug: string;
  tokens: Record<Role | "outsider" | "admin", string>;
  userIds: Record<Role | "outsider" | "admin", string>;
}

describe.skipIf(!hasTestDb)("permission matrix over every route (SP-TRQ5)", () => {
  let t: TestDb;
  let p: ReturnType<typeof prismaFor>;
  let app: ReturnType<typeof createApp>;
  let f: Fixture;

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

    const free = await p.prisma.plan.findFirstOrThrow({ where: { name: "free" } });

    async function user(email: string, isAdmin = false) {
      return p.prisma.user.create({
        data: {
          email,
          passwordHash: "x",
          name: email.split("@")[0] ?? email,
          isAdmin,
        },
      });
    }

    const owner = await user("owner-pm@example.com");
    const responder = await user("responder-pm@example.com");
    const viewer = await user("viewer-pm@example.com");
    const outsider = await user("outsider-pm@example.com");
    const admin = await user("admin-pm@example.com", true);

    const project = await p.prisma.project.create({
      data: {
        name: "PM Project",
        slug: "pm-project",
        planId: free.id,
      },
    });

    for (const [u, role] of [
      [owner, "Owner"],
      [responder, "Responder"],
      [viewer, "Viewer"],
    ] as const) {
      await p.prisma.membership.create({
        data: { projectId: project.id, userId: u.id, role },
      });
    }

    const service = await p.prisma.service.create({
      data: {
        projectId: project.id,
        name: "svc",
        url: "https://example.com/health",
        method: "GET",
        intervalSeconds: 60,
        timeoutSeconds: 10,
        expectedStatusCodes: [200],
        isPublic: true,
        version: 1,
      },
    });

    const incident = await p.prisma.incident.create({
      data: {
        projectId: project.id,
        serviceId: service.id,
        title: "test outage",
        status: "Investigating",
        origin: "manual",
        isPublic: true,
        openedByUserId: owner.id,
      },
    });

    const alert = await p.prisma.alert.create({
      data: {
        projectId: project.id,
        serviceId: service.id,
        incidentId: incident.id,
        state: "Outage",
      },
    });

    const tok = (id: string) => signAccessToken(id, SECRET, 3600);

    f = {
      projectId: project.id,
      serviceId: service.id,
      incidentId: incident.id,
      alertId: alert.id,
      slug: project.slug,
      tokens: {
        Owner: tok(owner.id),
        Responder: tok(responder.id),
        Viewer: tok(viewer.id),
        outsider: tok(outsider.id),
        admin: tok(admin.id),
      },
      userIds: {
        Owner: owner.id,
        Responder: responder.id,
        Viewer: viewer.id,
        outsider: outsider.id,
        admin: admin.id,
      },
    };
  });

  afterAll(async () => {
    await p?.close();
    await t?.close();
  });

  function auth(role: keyof Fixture["tokens"]) {
    return { Authorization: `Bearer ${f.tokens[role]}` };
  }

  type Case = {
    name: string;
    method: "get" | "post" | "patch" | "delete";
    path: string;
    /** Minimum role that may succeed (or touch the handler past auth). */
    min?: Role;
    /** Platform admin only. */
    admin?: boolean;
    /** Public / unauthenticated allowed. */
    public?: boolean;
    body?: object;
    headers?: Record<string, string>;
  };

  const projectRoutes = (): Case[] => {
    const pid = f.projectId;
    const sid = f.serviceId;
    const iid = f.incidentId;
    const aid = f.alertId;
    return [
      // projects
      { name: "POST /projects", method: "post", path: "/api/v1/projects", min: "Owner", body: { name: "X", slug: `x-${randomBytes(3).toString("hex")}` } },
      { name: "GET /projects", method: "get", path: "/api/v1/projects", min: "Owner" },
      { name: "GET /projects/:id", method: "get", path: `/api/v1/projects/${pid}`, min: "Viewer" },
      { name: "GET /projects/:id/members", method: "get", path: `/api/v1/projects/${pid}/members`, min: "Viewer" },
      {
        name: "POST /projects/:id/members",
        method: "post",
        path: `/api/v1/projects/${pid}/members`,
        min: "Owner",
        body: { email: "nobody@example.com", role: "Viewer" },
      },
      {
        name: "PATCH /projects/:id/members/:userId",
        method: "patch",
        path: `/api/v1/projects/${pid}/members/${f.userIds.Viewer}`,
        min: "Owner",
        body: { role: "Viewer" },
      },
      // services
      {
        name: "POST /services",
        method: "post",
        path: `/api/v1/projects/${pid}/services`,
        min: "Owner",
        body: {
          name: "n",
          url: "https://example.com/a",
          method: "GET",
          intervalSeconds: 60,
          timeoutSeconds: 5,
          expectedStatusCodes: [200],
          isPublic: false,
          failThreshold: 3,
          recoveryThreshold: 2,
          slowThreshold: 3,
        },
      },
      { name: "GET /services", method: "get", path: `/api/v1/projects/${pid}/services`, min: "Viewer" },
      { name: "GET /services/:id", method: "get", path: `/api/v1/projects/${pid}/services/${sid}`, min: "Viewer" },
      {
        name: "PATCH /services/:id",
        method: "patch",
        path: `/api/v1/projects/${pid}/services/${sid}`,
        min: "Owner",
        body: { name: "svc-renamed" },
      },
      {
        name: "GET /services/:id/versions",
        method: "get",
        path: `/api/v1/projects/${pid}/services/${sid}/versions`,
        min: "Owner",
      },
      {
        name: "POST /services/:id/disable",
        method: "post",
        path: `/api/v1/projects/${pid}/services/${sid}/disable`,
        min: "Owner",
      },
      {
        name: "POST /services/:id/enable",
        method: "post",
        path: `/api/v1/projects/${pid}/services/${sid}/enable`,
        min: "Owner",
      },
      // results + status
      {
        name: "GET /results",
        method: "get",
        path: `/api/v1/projects/${pid}/services/${sid}/results`,
        min: "Viewer",
      },
      {
        name: "GET /status",
        method: "get",
        path: `/api/v1/projects/${pid}/services/${sid}/status`,
        min: "Viewer",
      },
      {
        name: "GET /status/history",
        method: "get",
        path: `/api/v1/projects/${pid}/services/${sid}/status/history`,
        min: "Viewer",
      },
      {
        name: "POST /override",
        method: "post",
        path: `/api/v1/projects/${pid}/services/${sid}/override`,
        min: "Owner",
        body: {
          status: "Operational",
          reason: "matrix test",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      },
      {
        name: "DELETE /override",
        method: "delete",
        path: `/api/v1/projects/${pid}/services/${sid}/override`,
        min: "Owner",
      },
      // incidents
      { name: "GET /incidents", method: "get", path: `/api/v1/projects/${pid}/incidents`, min: "Viewer" },
      {
        name: "GET /incidents/:id",
        method: "get",
        path: `/api/v1/projects/${pid}/incidents/${iid}`,
        min: "Viewer",
      },
      {
        name: "POST /incidents",
        method: "post",
        path: `/api/v1/projects/${pid}/incidents`,
        min: "Responder",
        body: { serviceId: sid, title: "manual" },
      },
      {
        name: "POST /incidents/:id/updates",
        method: "post",
        path: `/api/v1/projects/${pid}/incidents/${iid}/updates`,
        min: "Responder",
        body: { status: "Identified", message: "looking", isPublic: false },
      },
      {
        name: "POST /incidents/:id/hide",
        method: "post",
        path: `/api/v1/projects/${pid}/incidents/${iid}/hide`,
        min: "Owner",
      },
      // alerts
      { name: "GET /alerts", method: "get", path: `/api/v1/projects/${pid}/alerts`, min: "Responder" },
      {
        name: "POST /alerts/:id/acknowledge",
        method: "post",
        path: `/api/v1/projects/${pid}/alerts/${aid}/acknowledge`,
        min: "Responder",
      },
      {
        name: "POST /alerts/:id/retry",
        method: "post",
        path: `/api/v1/projects/${pid}/alerts/${aid}/retry`,
        min: "Responder",
      },
      // plans
      { name: "GET /plans", method: "get", path: `/api/v1/projects/${pid}/plans`, min: "Viewer" },
      {
        name: "POST /plan",
        method: "post",
        path: `/api/v1/projects/${pid}/plan`,
        min: "Owner",
        body: { planName: "pro" },
        headers: { "Idempotency-Key": `pm-${randomBytes(4).toString("hex")}` },
      },
    ];
  };

  const adminRoutes: Case[] = [
    { name: "GET /admin/scheduler-failures", method: "get", path: "/api/v1/admin/scheduler-failures", admin: true },
    { name: "GET /admin/jobs", method: "get", path: "/api/v1/admin/jobs", admin: true },
    { name: "GET /admin/outbox", method: "get", path: "/api/v1/admin/outbox", admin: true },
    { name: "GET /admin/audit", method: "get", path: "/api/v1/admin/audit", admin: true },
    { name: "GET /admin/users", method: "get", path: "/api/v1/admin/users", admin: true },
  ];

  const publicRoutes: Case[] = [
    { name: "GET /public/:slug", method: "get", path: "/api/v1/public/pm-project", public: true },
    {
      name: "POST /public/:slug/subscribe",
      method: "post",
      path: "/api/v1/public/pm-project/subscribe",
      public: true,
      body: { email: "sub@example.com", serviceIds: [] },
    },
    {
      name: "POST /public/subscriptions/verify",
      method: "post",
      path: "/api/v1/public/subscriptions/verify",
      public: true,
      body: { token: "not-a-real-token-0123456789abcdef" },
    },
  ];

  const rank: Record<Role, number> = { Viewer: 1, Responder: 2, Owner: 3 };

  function call(c: Case, headers: Record<string, string> = {}) {
    const req = request(app)[c.method](c.path);
    for (const [k, v] of Object.entries({ ...c.headers, ...headers })) {
      req.set(k, v);
    }
    if (c.body) req.send(c.body);
    return req;
  }

  it("rejects unauthenticated callers with 401 on every protected route", async () => {
    const cases = [...projectRoutes(), ...adminRoutes];
    for (const c of cases) {
      const res = await call(c);
      expect(res.status, c.name).toBe(401);
    }
  });

  it("returns 404 for a non-member on every project-scoped route", async () => {
    for (const c of projectRoutes()) {
      const res = await call(c, auth("outsider"));
      // Project create and list are not project-scoped membership checks the same way:
      // POST /projects and GET /projects only need auth.
      if (c.path === "/api/v1/projects" && (c.method === "post" || c.method === "get")) {
        expect([200, 201, 422, 409]).toContain(res.status);
        continue;
      }
      expect(res.status, c.name).toBe(404);
    }
  });

  it("returns 403 when the member role is below the minimum", async () => {
    const roles: Role[] = ["Viewer", "Responder", "Owner"];
    for (const c of projectRoutes()) {
      if (!c.min) continue;
      if (c.path === "/api/v1/projects") continue;
      for (const role of roles) {
        if (rank[role] >= rank[c.min]) continue;
        const res = await call(c, auth(role));
        expect(res.status, `${c.name} as ${role}`).toBe(403);
      }
    }
  });

  it("allows a member at or above the minimum role past the permission gate", async () => {
    for (const c of projectRoutes()) {
      if (!c.min) continue;
      if (c.path === "/api/v1/projects") continue;
      const res = await call(c, auth(c.min));
      // May be 200/201/409/422/410 depending on body — but never 401/403/404
      expect([401, 403, 404], c.name).not.toContain(res.status);
    }
  });

  it("admin routes: non-admin 403, admin allowed past the gate", async () => {
    for (const c of adminRoutes) {
      const denied = await call(c, auth("Owner"));
      expect(denied.status, `${c.name} as Owner`).toBe(403);
      const allowed = await call(c, auth("admin"));
      expect([401, 403], c.name).not.toContain(allowed.status);
    }
  });

  it("public routes remain reachable without a token", async () => {
    for (const c of publicRoutes) {
      const res = await call(c);
      expect(res.status, c.name).not.toBe(401);
      expect(res.status, c.name).not.toBe(403);
    }
  });
});
