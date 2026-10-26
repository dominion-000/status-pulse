import { randomBytes } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { signAccessToken } from "../../src/auth/tokens";
import { loadConfig } from "../../src/config";
import { acknowledgeAlert } from "../../src/db/acknowledge-alert";
import {
  createTestDb,
  hasTestDb,
  prismaFor,
  type TestDb,
} from "../helpers/test-db";

const SECRET = "s".repeat(40);

describe.skipIf(!hasTestDb)("shared write paths (UI bypass closure)", () => {
  let t: TestDb;
  let p: ReturnType<typeof prismaFor>;
  let app: ReturnType<typeof createApp>;
  let ownerId: string;
  let projectId: string;
  let alertId: string;
  let token: string;

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

    const owner = await p.prisma.user.create({
      data: { email: "owner-sw@example.com", passwordHash: "x", name: "Owner" },
    });
    ownerId = owner.id;
    token = signAccessToken(owner.id, SECRET, 3600);

    const free = await p.prisma.plan.findFirstOrThrow({ where: { name: "free" } });
    const project = await p.prisma.project.create({
      data: { name: "SW", slug: "sw-shared", planId: free.id },
    });
    projectId = project.id;
    await p.prisma.membership.create({
      data: { projectId, userId: ownerId, role: "Owner" },
    });
    const service = await p.prisma.service.create({
      data: {
        projectId,
        name: "svc",
        url: "https://example.com",
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
        projectId,
        serviceId: service.id,
        title: "outage",
        status: "Investigating",
        origin: "auto",
        isPublic: true,
        openedByUserId: ownerId,
      },
    });
    const alert = await p.prisma.alert.create({
      data: {
        projectId,
        serviceId: service.id,
        incidentId: incident.id,
        state: "Outage",
      },
    });
    alertId = alert.id;
  });

  afterAll(async () => {
    await p?.close();
    await t?.close();
  });

  it("acknowledgeAlert writes an audit row and is race-safe", async () => {
    const [a, b] = await Promise.all([
      acknowledgeAlert(p.prisma, {
        projectId,
        alertId,
        actorUserId: ownerId,
      }),
      acknowledgeAlert(p.prisma, {
        projectId,
        alertId,
        actorUserId: ownerId,
      }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.acknowledgement.id).toBe(b.acknowledgement.id);
    const createdCount = [a, b].filter((r) => r.ok && r.created).length;
    expect(createdCount).toBe(1);

    const audits = await p.prisma.auditLog.findMany({
      where: { action: "alert.acknowledge", entityId: alertId },
    });
    expect(audits.length).toBe(1);
    expect(audits[0].actorUserId).toBe(ownerId);
  });

  it("API acknowledge returns 200 on second call and keeps a single audit", async () => {
    // already acknowledged above
    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/alerts/${alertId}/acknowledge`)
      .set("Authorization", `Bearer ${token}`);
    expect([200, 201]).toContain(res.status);
    const audits = await p.prisma.auditLog.findMany({
      where: { action: "alert.acknowledge", entityId: alertId },
    });
    expect(audits.length).toBe(1);
  });
});
