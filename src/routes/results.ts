import { Router } from "express";
import type { PrismaClient } from "../../prisma/generated";
import type { Config } from "../config";
import { requireAuth, loadUser } from "../middleware/auth";
import { requireMembership } from "../middleware/permissions";
import { notFoundError } from "../errors";
import { param } from "../http-params";

export function resultRoutes(prisma: PrismaClient, config: Config): Router {
  const r = Router({ mergeParams: true });
  const auth = [requireAuth(config), loadUser(prisma)];

  r.get(
    "/",
    ...auth,
    requireMembership(prisma, "Viewer", "projectId"),
    async (req, res, next) => {
      try {
        const serviceId = param(req, "serviceId");
        const projectId = param(req, "projectId");
        const service = await prisma.service.findFirst({
          where: {
            id: serviceId,
            projectId,
            deletedAt: null,
          },
        });
        if (!service) return next(notFoundError());

        const limit = Math.min(Number(req.query.limit) || 50, 200);
        const results = await prisma.checkResult.findMany({
          where: { serviceId: service.id },
          orderBy: { checkedAt: "desc" },
          take: limit,
        });

        res.json({
          results: results.map((row) => ({
            id: row.id,
            jobId: row.jobId,
            statusCode: row.statusCode,
            latencyMs: row.latencyMs,
            passed: row.passed,
            failureReason: row.failureReason,
            configVersion: row.configVersion,
            checkedAt: row.checkedAt.toISOString(),
          })),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return r;
}
