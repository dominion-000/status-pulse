import { Router } from "express";
import { z } from "zod";
import { createProjectSchema } from "../core/project-input";
import { createProject, inviteMember } from "../db/projects";
import type { PrismaClient } from "../../prisma/generated";
import type { Config } from "../config";
import { requireAuth, loadUser } from "../middleware/auth";
import { requireMembership } from "../middleware/permissions";
import { validateBody } from "../middleware/validate";
import { conflictError, notFoundError, validationError } from "../errors";
import { param } from "../http-params";

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["Responder", "Viewer"]),
});

const roleSchema = z.object({
  role: z.enum(["Owner", "Responder", "Viewer"]),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function projectShape(p: {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
}) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    createdAt: p.createdAt.toISOString(),
  };
}

export function projectRoutes(prisma: PrismaClient, config: Config): Router {
  const r = Router();
  const auth = [requireAuth(config), loadUser(prisma)];

  r.post(
    "/",
    ...auth,
    validateBody(createProjectSchema),
    async (req, res, next) => {
      try {
        const { name, slug } = req.body as z.infer<typeof createProjectSchema>;
        const outcome = await createProject(prisma, {
          actorUserId: req.user!.id,
          name,
          slug,
        });
        if (outcome.kind === "slug_taken")
          return next(conflictError("Slug already taken"));
        if (outcome.kind === "plans_missing")
          return next(new Error("free plan is not seeded"));
        const project = outcome.project;

        res.status(201).json({ project: projectShape(project) });
      } catch (err) {
        next(err);
      }
    },
  );

  r.get("/", ...auth, async (req, res, next) => {
    try {
      const memberships = await prisma.membership.findMany({
        where: { userId: req.user!.id },
        include: { project: true },
      });
      res.json({
        projects: memberships.map((m) => ({
          ...projectShape(m.project),
          role: m.role,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  r.get(
    "/:projectId",
    ...auth,
    requireMembership(prisma, "Viewer"),
    async (req, res, next) => {
      try {
        const projectId = param(req, "projectId");
        const project = await prisma.project.findUnique({
          where: { id: projectId },
        });
        if (!project) return next(notFoundError());
        const membership = await prisma.membership.findUnique({
          where: {
            projectId_userId: { projectId, userId: req.user!.id },
          },
        });
        res.json({
          project: { ...projectShape(project), role: membership?.role },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  r.post(
    "/:projectId/members",
    ...auth,
    requireMembership(prisma, "Owner"),
    validateBody(inviteSchema),
    async (req, res, next) => {
      try {
        const { email, role } = req.body as z.infer<typeof inviteSchema>;
        const outcome = await inviteMember(prisma, {
          projectId: param(req, "projectId"),
          actorUserId: req.user!.id,
          email,
          role,
        });
        if (outcome.kind === "no_user")
          return next(
            validationError("User not found", [
              { path: "email", message: "no account with this email" },
            ]),
          );
        if (outcome.kind === "already_member")
          return next(conflictError("User is already a member"));
        if (outcome.kind === "plan_limit")
          return next(conflictError(outcome.message));
        const user = outcome.user;

        res.status(201).json({
          member: { userId: user.id, email: user.email, role },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // Change a member's role (SP-01.4).
  r.patch(
    "/:projectId/members/:userId",
    ...auth,
    requireMembership(prisma, "Owner"),
    validateBody(roleSchema),
    async (req, res, next) => {
      try {
        const { role } = req.body as z.infer<typeof roleSchema>;
        const projectId = param(req, "projectId");
        const userId = param(req, "userId");
        if (!UUID.test(userId)) return next(notFoundError());

        const member = await prisma.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<{ user_id: string; role: string }[]>`
            SELECT user_id, role FROM memberships
             WHERE project_id = ${projectId}::uuid
               FOR UPDATE`;
          const target = rows.find((m) => m.user_id === userId);
          if (!target) throw notFoundError("Member not found");
          const user = await tx.user.findUniqueOrThrow({
            where: { id: userId },
            select: { email: true },
          });
          if (target.role === role) return { userId, email: user.email, role }; // nothing to change, nothing to audit

          const owners = rows.filter((m) => m.role === "Owner").length;
          if (target.role === "Owner" && owners <= 1)
            throw conflictError("A project must keep at least one Owner");

          await tx.membership.update({
            where: { projectId_userId: { projectId, userId } },
            data: { role },
          });
          await tx.auditLog.create({
            data: {
              projectId,
              actorUserId: req.user!.id,
              action: "member.role_changed",
              entityType: "membership",
              entityId: userId,
              details: { from: target.role, to: role },
            },
          });
          return { userId, email: user.email, role };
        });
        res.json({ member });
      } catch (err) {
        next(err);
      }
    },
  );

  r.get(
    "/:projectId/members",
    ...auth,
    requireMembership(prisma, "Viewer"),
    async (req, res, next) => {
      try {
        const projectId = param(req, "projectId");
        const members = await prisma.membership.findMany({
          where: { projectId },
          include: { user: { select: { id: true, email: true, name: true } } },
        });
        res.json({
          members: members.map((m) => ({
            userId: m.user.id,
            email: m.user.email,
            name: m.user.name,
            role: m.role,
          })),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return r;
}
