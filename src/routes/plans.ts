import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "../../prisma/generated";
import type { Config } from "../config";
import { conflictError, notFoundError, validationError } from "../errors";
import { param } from "../http-params";
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
        const key = idempotencyKey.trim();

        const target = await prisma.plan.findUnique({
          where: { name: planName },
        });
        if (!target) return next(notFoundError("Plan not found"));

        const project = await prisma.project.findUnique({
          where: { id: projectId },
          include: { plan: true },
        });
        if (!project) return next(notFoundError());

        const existing = await prisma.paymentAttempt.findUnique({
          where: {
            projectId_idempotencyKey: { projectId, idempotencyKey: key },
          },
          include: { plan: true },
        });

        if (existing) {
          if (existing.planId !== target.id) {
            return res.status(422).json({
              error: {
                code: "IDEMPOTENCY_CONFLICT",
                message:
                  "Idempotency-Key was already used with a different plan",
              },
            });
          }
          if (existing.status === "succeeded") {
            res.json({
              plan: {
                name: existing.plan.name,
                maxServices: existing.plan.maxServices,
                maxMembers: existing.plan.maxMembers,
                priceCents: existing.plan.priceCents,
              },
              payment: {
                id: existing.id,
                status: existing.status,
                amountCents: existing.amountCents,
              },
            });
            return;
          }
          return next(
            conflictError(
              existing.errorMessage ?? "Previous payment attempt failed",
            ),
          );
        }

        const failAll =
          process.env.PAYMENT_FAIL_ALL === "1" ||
          process.env.PAYMENT_FAIL_ALL === "true";
        const amount = target.priceCents;

        if (failAll) {
          await prisma.paymentAttempt.create({
            data: {
              projectId,
              planId: target.id,
              idempotencyKey: key,
              status: "failed",
              amountCents: amount,
              errorMessage: "PAYMENT_FAIL_ALL is set",
            },
          });
          return next(conflictError("Simulated payment failed"));
        }

        const attempt = await prisma.$transaction(async (tx) => {
          const payment = await tx.paymentAttempt.create({
            data: {
              projectId,
              planId: target.id,
              idempotencyKey: key,
              status: "succeeded",
              amountCents: amount,
            },
          });
          await tx.project.update({
            where: { id: projectId },
            data: { planId: target.id },
          });
          await tx.auditLog.create({
            data: {
              projectId,
              actorUserId: req.user!.id,
              action: "plan.upgraded",
              entityType: "project",
              entityId: projectId,
              details: {
                from: project.plan.name,
                to: target.name,
                paymentId: payment.id,
              },
            },
          });
          return payment;
        });

        res.status(201).json({
          plan: {
            name: target.name,
            maxServices: target.maxServices,
            maxMembers: target.maxMembers,
            priceCents: target.priceCents,
          },
          payment: {
            id: attempt.id,
            status: attempt.status,
            amountCents: attempt.amountCents,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return r;
}
