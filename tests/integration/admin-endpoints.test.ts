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

describe.skipIf(!hasTestDb)(
  "administrator endpoints (SP-08.1, SP-08.4, SP-1FYY)",
  () => {
    let t: TestDb;
    let p: ReturnType<typeof prismaFor>;
    let app: ReturnType<typeof createApp>;
    let adminToken: string;
    let userToken: string;
    let adminId: string;
    let userId: string;

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

      const admin = await p.prisma.user.create({
        data: {
          email: "admin@example.com",
          passwordHash: "x",
          name: "Admin",
          isAdmin: true,
        },
      });
      const user = await p.prisma.user.create({
        data: {
          email: "user@example.com",
          passwordHash: "x",
          name: "Regular",
          isAdmin: false,
        },
      });
      adminId = admin.id;
      userId = user.id;
      adminToken = signAccessToken(admin.id, SECRET, 3600);
      userToken = signAccessToken(user.id, SECRET, 3600);

      await p.prisma.schedulerFailure.create({
        data: { message: "tick failed", details: { reason: "test" } },
      });
      await p.prisma.auditLog.create({
        data: {
          actorUserId: adminId,
          action: "membership.invite",
          entityType: "membership",
          entityId: null,
          details: { role: "Viewer" },
        },
      });
    });

    afterAll(async () => {
      await p?.close();
      await t?.close();
    });

    it("rejects unauthenticated callers with 401", async () => {
      const res = await request(app).get("/api/v1/admin/users");
      expect(res.status).toBe(401);
    });

    it("rejects non-admin authenticated callers with 403", async () => {
      const res = await request(app)
        .get("/api/v1/admin/users")
        .set("Authorization", `Bearer ${userToken}`);
      expect(res.status).toBe(403);
    });

    it("lists users for an admin", async () => {
      const res = await request(app)
        .get("/api/v1/admin/users")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.users.length).toBeGreaterThanOrEqual(2);
      const adminRow = res.body.users.find(
        (u: { id: string }) => u.id === adminId,
      );
      expect(adminRow.isAdmin).toBe(true);
    });

    it("lists scheduler failures", async () => {
      const res = await request(app)
        .get("/api/v1/admin/scheduler-failures")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.failures.length).toBeGreaterThanOrEqual(1);
      expect(res.body.failures[0].message).toBe("tick failed");
    });

    it("returns an empty jobs list when nothing matches", async () => {
      const res = await request(app)
        .get("/api/v1/admin/jobs?minAttempts=99")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.jobs).toEqual([]);
    });

    it("returns undelivered outbox (empty ok)", async () => {
      const res = await request(app)
        .get("/api/v1/admin/outbox")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.messages)).toBe(true);
    });

    it("returns audit entries including access changes", async () => {
      const res = await request(app)
        .get("/api/v1/admin/audit?accessChanges=1")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.entries.length).toBeGreaterThanOrEqual(1);
      expect(res.body.entries[0].action).toContain("membership");
    });

    it("non-admin cannot read audit", async () => {
      const res = await request(app)
        .get("/api/v1/admin/audit")
        .set("Authorization", `Bearer ${userToken}`);
      expect(res.status).toBe(403);
    });
  },
);
