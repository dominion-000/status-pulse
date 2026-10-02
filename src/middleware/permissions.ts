import type { RequestHandler } from "express";
import type { PrismaClient } from "../../prisma/generated";
import { forbiddenError, notFoundError, unauthorizedError } from "../errors";
import { param } from "../http-params";

export type Role = "Owner" | "Responder" | "Viewer";

const ROLE_RANK: Record<Role, number> = {
  Viewer: 1,
  Responder: 2,
  Owner: 3,
};

export function requireMembership(
  prisma: PrismaClient,
  minRole: Role,
  projectIdParam = "projectId",
): RequestHandler {
  return async (req, _res, next) => {
    if (!req.user) return next(unauthorizedError());
    try {
      const projectId = param(req, projectIdParam);
      const membership = await prisma.membership.findUnique({
        where: {
          projectId_userId: { projectId, userId: req.user.id },
        },
      });
      if (!membership) return next(notFoundError());
      const rank = ROLE_RANK[membership.role as Role] ?? 0;
      if (rank < ROLE_RANK[minRole]) return next(forbiddenError());
      next();
    } catch (err) {
      next(err);
    }
  };
}
