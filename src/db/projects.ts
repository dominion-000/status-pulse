import { Prisma, type PrismaClient } from "../../prisma/generated";
import { lockProject } from "./project-lock";

export type CreateProjectOutcome =
  | { kind: "ok"; project: Awaited<ReturnType<PrismaClient["project"]["create"]>> }
  | { kind: "slug_taken" }
  | { kind: "plans_missing" };

/**
 * Creates a project on the free plan with the caller as its Owner, and writes the audit row (SP-01). The API and
 * the browser UI both call this. Two requests for the same slug cannot both succeed: the unique index decides.
 */
export async function createProject(
  prisma: PrismaClient,
  args: { actorUserId: string; name: string; slug: string },
): Promise<CreateProjectOutcome> {
  const freePlan = await prisma.plan.findUnique({ where: { name: "free" } });
  if (!freePlan) return { kind: "plans_missing" };
  try {
    const project = await prisma.$transaction(async (tx) => {
      const p = await tx.project.create({
        data: { name: args.name, slug: args.slug, planId: freePlan.id },
      });
      await tx.membership.create({
        data: { projectId: p.id, userId: args.actorUserId, role: "Owner" },
      });
      await tx.auditLog.create({
        data: {
          projectId: p.id,
          actorUserId: args.actorUserId,
          action: "project.created",
          entityType: "project",
          entityId: p.id,
          details: { name: args.name, slug: args.slug },
        },
      });
      return p;
    });
    return { kind: "ok", project };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    )
      return { kind: "slug_taken" };
    throw err;
  }
}

export type InviteOutcome =
  | { kind: "ok"; user: { id: string; email: string }; role: string }
  | { kind: "no_user" }
  | { kind: "already_member" }
  | { kind: "plan_limit"; message: string };

/**
 * Adds an existing user to a project (SP-01.3). The project row is locked while the members are counted, so the
 * plan limit holds under concurrent invitations. A user who is already a member is reported as such before the
 * limit is considered.
 */
export async function inviteMember(
  prisma: PrismaClient,
  args: {
    projectId: string;
    actorUserId: string;
    email: string;
    role: "Responder" | "Viewer";
  },
): Promise<InviteOutcome> {
  const user = await prisma.user.findUnique({
    where: { email: args.email.toLowerCase() },
  });
  if (!user) return { kind: "no_user" };

  return prisma.$transaction(
    async (tx): Promise<InviteOutcome> => {
    await lockProject(tx, args.projectId);
    const existing = await tx.membership.findUnique({
      where: { projectId_userId: { projectId: args.projectId, userId: user.id } },
    });
    if (existing) return { kind: "already_member" };

    const project = await tx.project.findUniqueOrThrow({
      where: { id: args.projectId },
      include: { plan: true },
    });
    const members = await tx.membership.count({
      where: { projectId: args.projectId },
    });
    if (members >= project.plan.maxMembers)
      return {
        kind: "plan_limit",
        message: `Plan limit reached: ${project.plan.name} allows ${project.plan.maxMembers} members`,
      };

    await tx.membership.create({
      data: { projectId: args.projectId, userId: user.id, role: args.role },
    });
    await tx.auditLog.create({
      data: {
        projectId: args.projectId,
        actorUserId: args.actorUserId,
        action: "member.invited",
        entityType: "membership",
        entityId: user.id,
        details: { email: user.email, role: args.role },
      },
    });
    return {
      kind: "ok",
      user: { id: user.id, email: user.email },
      role: args.role,
    };
  },
    { maxWait: 15_000, timeout: 30_000 },
  );
}
