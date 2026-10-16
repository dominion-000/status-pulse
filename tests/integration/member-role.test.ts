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

describe.skipIf(!hasTestDb)("changing a member's role (SP-01.4)", () => {
  let t: TestDb;
  let p: ReturnType<typeof prismaFor>;
  let app: ReturnType<typeof createApp>;
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
  });
  afterAll(async () => {
    await p?.close();
    await t?.close();
  });

  async function setup<K extends string>(
    roles: Record<K, "Owner" | "Responder" | "Viewer">,
  ) {
    n += 1;
    const project = (
      await t.client.query(
        `INSERT INTO projects (name, slug) VALUES ($1, $1) RETURNING id`,
        [`p${n}`],
      )
    ).rows[0].id as string;
      await t.client.query(
        `UPDATE projects SET plan_id = (SELECT id FROM plans WHERE name = 'pro') WHERE id = $1`,
        [project],
      );
const users = {} as Record<K, string>;
    for (const [name, role] of Object.entries(roles) as [
      K,
      "Owner" | "Responder" | "Viewer",
    ][]) {
      const id = (
        await t.client.query(
          `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
          [`${name}${n}@x.io`],
        )
      ).rows[0].id as string;
      users[name] = id;
      await t.client.query(
        `INSERT INTO memberships (project_id, user_id, role) VALUES ($1, $2, $3)`,
        [project, id, role],
      );
    }
    return { project, users };
  }
  const outsider = async () =>
    (
      await t.client.query(
        `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
        [`out${++n}@x.io`],
      )
    ).rows[0].id as string;
  const change = (
    project: string,
    target: string,
    actor: string,
    role: unknown,
  ) =>
    request(app)
      .patch(`/api/v1/projects/${project}/members/${target}`)
      .set({ Authorization: `Bearer ${signAccessToken(actor, SECRET, 900)}` })
      .send({ role });
  const roleOf = async (project: string, user: string) =>
    (
      await t.client.query(
        `SELECT role FROM memberships WHERE project_id = $1 AND user_id = $2`,
        [project, user],
      )
    ).rows[0]?.role;
  const audits = async (project: string, user: string) =>
    (
      await t.client.query(
        `SELECT actor_user_id, details FROM audit_log WHERE project_id = $1 AND entity_id = $2 AND action = 'member.role_changed'`,
        [project, user],
      )
    ).rows;

  it("lets an owner change a role, and records who, from and to", async () => {
    const { project, users } = await setup({ boss: "Owner", ann: "Viewer" });
    const res = await change(project, users.ann, users.boss, "Responder");
    expect(res.status).toBe(200);
    expect(res.body.member).toMatchObject({
      userId: users.ann,
      role: "Responder",
    });
    expect(await roleOf(project, users.ann)).toBe("Responder");
    expect(await audits(project, users.ann)).toEqual([
      {
        actor_user_id: users.boss,
        details: { from: "Viewer", to: "Responder" },
      },
    ]);
  });

  it("takes effect on the very next request", async () => {
    const { project, users } = await setup({ boss: "Owner", ann: "Responder" });
    const post = () =>
      request(app)
        .post(`/api/v1/projects/${project}/incidents`)
        .set({
          Authorization: `Bearer ${signAccessToken(users.ann, SECRET, 900)}`,
        })
        .send({
          serviceId: "00000000-0000-0000-0000-000000000000",
          title: "abc",
        });
    expect((await post()).status).toBe(404); // allowed in, then the service is missing
    await change(project, users.ann, users.boss, "Viewer");
    expect((await post()).status).toBe(403);
  });

  it("is for owners only", async () => {
    const { project, users } = await setup({
      boss: "Owner",
      rex: "Responder",
      vic: "Viewer",
    });
    expect((await change(project, users.vic, users.rex, "Owner")).status).toBe(
      403,
    );
    expect((await change(project, users.vic, users.vic, "Owner")).status).toBe(
      403,
    );
    expect(
      (await change(project, users.vic, await outsider(), "Viewer")).status,
    ).toBe(404);
    expect(await roleOf(project, users.vic)).toBe("Viewer");
    const anon = await request(app)
      .patch(`/api/v1/projects/${project}/members/${users.vic}`)
      .send({ role: "Viewer" });
    expect(anon.status).toBe(401);
  });

  it("answers 404 for a user who is not a member and for a malformed id", async () => {
    const { project, users } = await setup({ boss: "Owner" });
    expect(
      (await change(project, await outsider(), users.boss, "Viewer")).status,
    ).toBe(404);
    expect(
      (await change(project, "not-a-uuid", users.boss, "Viewer")).status,
    ).toBe(404);
  });

  it("validates the role", async () => {
    const { project, users } = await setup({ boss: "Owner", ann: "Viewer" });
    for (const role of ["Admin", "owner", "", null, undefined])
      expect(
        (await change(project, users.ann, users.boss, role)).status,
        String(role),
      ).toBe(422);
    expect(await roleOf(project, users.ann)).toBe("Viewer");
  });

  it("treats the same role as no change and writes no audit row", async () => {
    const { project, users } = await setup({ boss: "Owner", ann: "Viewer" });
    const res = await change(project, users.ann, users.boss, "Viewer");
    expect(res.status).toBe(200);
    expect(await audits(project, users.ann)).toHaveLength(0);
  });

  it("never leaves a project without an owner", async () => {
    const { project, users } = await setup({ boss: "Owner", ann: "Viewer" });
    const self = await change(project, users.boss, users.boss, "Responder");
    expect(self.status).toBe(409);
    expect(await roleOf(project, users.boss)).toBe("Owner");
    // Promote a second owner: now the first may step down.
    expect((await change(project, users.ann, users.boss, "Owner")).status).toBe(
      200,
    );
    expect(
      (await change(project, users.boss, users.boss, "Responder")).status,
    ).toBe(200);
    expect((await change(project, users.ann, users.ann, "Viewer")).status).toBe(
      409,
    );
  });

  it("lets only one of two simultaneous demotions succeed", async () => {
    const { project, users } = await setup({ a: "Owner", b: "Owner" });
    const codes = (
      await Promise.all([
        change(project, users.b, users.a, "Viewer"),
        change(project, users.a, users.b, "Viewer"),
      ])
    )
      .map((r) => r.status)
      .sort();
    expect(codes[0]).toBe(200);
    expect([403, 409]).toContain(codes[1]);
    const owners = await t.client.query(
      `SELECT count(*)::int AS n FROM memberships WHERE project_id = $1 AND role = 'Owner'`,
      [project],
    );
    expect(owners.rows[0].n).toBe(1);
  });

  it("waits for the project's membership rows instead of counting owners from a stale read", async () => {
    const { project, users } = await setup({
      a: "Owner",
      b: "Owner",
      c: "Viewer",
    });
    await t.client.query("BEGIN");
    try {
      await t.client.query(
        `SELECT 1 FROM memberships WHERE project_id = $1 AND user_id = $2 FOR UPDATE`,
        [project, users.c],
      );
      let finished = false;
      const pending = change(project, users.b, users.a, "Viewer").then((r) => {
        finished = true;
        return r;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(finished).toBe(false); // blocked on the row lock
      await t.client.query("ROLLBACK");
      expect((await pending).status).toBe(200);
    } finally {
      await t.client.query("ROLLBACK").catch(() => {});
    }
  });

  it("does not touch memberships of other projects", async () => {
    const one = await setup({ boss: "Owner", ann: "Viewer" });
    const two = await setup({ boss: "Owner" });
    expect(
      (await change(two.project, one.users.ann, two.users.boss, "Owner"))
        .status,
    ).toBe(404);
    expect(
      (await change(two.project, one.users.ann, one.users.boss, "Owner"))
        .status,
    ).toBe(404);
    expect(await roleOf(one.project, one.users.ann)).toBe("Viewer");
  });
});
