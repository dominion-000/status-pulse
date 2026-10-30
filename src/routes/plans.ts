import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "../../prisma/generated";
import type { Config } from "../config";
import { conflictError, notFoundError, validationError } from "../errors";
import { param } from "../http-params";
import { upgradePlan } from "../db/plans";
import { loadUser, requireAuth } from "../middleware/auth";
import { requireMembership } from "../middleware/permissions";
import { validateBody } from "../middleware/validate";

const upgradeSchema = z.object({
  planName: z.enum(["free", "pro"]),
});

/**
 * Plan listing and upgrade with Idempotency-Key (SP-07.4, SP-07.5).
 * Mounted under /projects/:projectId.
 */
export function planRoutes(prisma: PrismaClient, config: Config): Router {
  const r = Router({ mergeParams: true });
  const auth = [requireAuth(config), loadUser(prisma)];

  r.get(
    "/plans",
    ...auth,
    requireMembership(prisma, "Viewer", "projectId"),
    async (req, res, next) => {
      try {
        const projectId = param(req, "projectId");
        const project = await prisma.project.findUnique({
          where: { id: projectId },
          include: { plan: true },
        });
        if (!project) return next(notFoundError());

        const plans = await prisma.plan.findMany({
          orderBy: { priceCents: "asc" },
        });
        res.json({
          current: {
            name: project.plan.name,
            maxServices: project.plan.maxServices,
            maxMembers: project.plan.maxMembers,
            priceCents: project.plan.priceCents,
          },
          plans: plans.map((p) => ({
            name: p.name,
            maxServices: p.maxServices,
            maxMembers: p.maxMembers,
            priceCents: p.priceCents,
          })),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  r.post(
    "/plan",
    ...auth,
    requireMembership(prisma, "Owner", "projectId"),
    validateBody(upgradeSchema),
    async (req, res, next) => {
      try {
        const projectId = param(req, "projectId");
        const { planName } = req.body as z.infer<typeof upgradeSchema>;
        const idempotencyKey = req.headers["idempotency-key"];
        if (
          typeof idempotencyKey !== "string" ||
          idempotencyKey.trim().length < 8
        ) {
          return next(
            validationError(
              "Idempotency-Key header is required (min 8 characters)",
            ),
          );
        }
        const outcome = await upgradePlan(prisma, {
          projectId,
          actorUserId: req.user!.id,
          planName,
          key: idempotencyKey.trim(),
          failPayments:
            process.env.PAYMENT_FAIL_ALL === "1" ||
            process.env.PAYMENT_FAIL_ALL === "true",
        });
        switch (outcome.kind) {
          case "unknown_plan":
            return next(notFoundError("Plan not found"));
          case "key_conflict":
            return res.status(422).json({
              error: {
                code: "IDEMPOTENCY_CONFLICT",
                message:
                  "Idempotency-Key was already used with a different plan",
              },
            });
          case "over_limit":
          case "payment_failed":
            return next(conflictError(outcome.message));
          case "ok":
            res.status(outcome.replayed ? 200 : 201).json({
              plan: outcome.plan,
              payment: outcome.payment,
            });
            return;
        }
      } catch (err) {
        next(err);
      }
    },
  );

  return r;
}
