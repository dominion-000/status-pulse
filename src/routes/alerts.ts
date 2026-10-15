import { Router } from "express";
import type { PrismaClient } from "../../prisma/generated";
import type { Config } from "../config";
import { systemClock } from "../core/clock";
import { conflictError, notFoundError } from "../errors";
import { param } from "../http-params";
import { loadUser, requireAuth } from "../middleware/auth";
import { requireMembership } from "../middleware/permissions";

function alertView(a: {
  id: string;
  serviceId: string;
  incidentId: string;
  state: string;
  createdAt: Date;
  acknowledgement: {
    id: string;
    actorUserId: string;
    createdAt: Date;
  } | null;
  messages: {
    id: string;
    recipientEmail: string;
    attempts: number;
    lastError: string | null;
    nextAttemptAt: Date;
    deliveredAt: Date | null;
  }[];
}) {
  return {
    id: a.id,
    serviceId: a.serviceId,
    incidentId: a.incidentId,
    state: a.state,
    createdAt: a.createdAt.toISOString(),
    acknowledgement: a.acknowledgement
      ? {
          id: a.acknowledgement.id,
          actorUserId: a.acknowledgement.actorUserId,
          createdAt: a.acknowledgement.createdAt.toISOString(),
        }
      : null,
    messages: a.messages.map((m) => ({
      id: m.id,
      recipientEmail: m.recipientEmail,
      attempts: m.attempts,
      lastError: m.lastError,
      nextAttemptAt: m.nextAttemptAt.toISOString(),
      deliveredAt: m.deliveredAt ? m.deliveredAt.toISOString() : null,
    })),
  };
}

export function alertRoutes(prisma: PrismaClient, config: Config): Router {
  const r = Router({ mergeParams: true });
  const auth = [requireAuth(config), loadUser(prisma)];

  // List alerts for a project. Responder+ (owners and responders receive them).
  r.get(
    "/",
    ...auth,
    requireMembership(prisma, "Responder", "projectId"),
    async (req, res, next) => {
      try {
        const projectId = param(req, "projectId");
        const serviceId =
          typeof req.query.serviceId === "string"
            ? req.query.serviceId
            : undefined;
        const state =
          typeof req.query.state === "string" ? req.query.state : undefined;

        const alerts = await prisma.alert.findMany({
          where: {
            projectId,
            ...(serviceId ? { serviceId } : {}),
            ...(state ? { state } : {}),
          },
          include: {
            acknowledgement: true,
            messages: {
              orderBy: { recipientEmail: "asc" },
            },
          },
          orderBy: { createdAt: "desc" },
          take: 100,
        });

        res.json({ alerts: alerts.map(alertView) });
      } catch (err) {
        next(err);
      }
    },
  );

  // Acknowledge an alert. Idempotent: a second call returns the existing row.
  // Never marks any outbox message as delivered (SP-06.4).
  r.post(
    "/:alertId/acknowledge",
    ...auth,
    requireMembership(prisma, "Responder", "projectId"),
    async (req, res, next) => {
      try {
        const projectId = param(req, "projectId");
        const alertId = param(req, "alertId");
        const userId = req.user!.id;

        const alert = await prisma.alert.findFirst({
          where: { id: alertId, projectId },
          include: { acknowledgement: true },
        });
        if (!alert) return next(notFoundError());

        if (alert.acknowledgement) {
          res.json({
            acknowledgement: {
              id: alert.acknowledgement.id,
              actorUserId: alert.acknowledgement.actorUserId,
              createdAt: alert.acknowledgement.createdAt.toISOString(),
            },
          });
          return;
        }

        const ack = await prisma.acknowledgement.create({
          data: {
            alertId,
            actorUserId: userId,
          },
        });

        await prisma.auditLog.create({
          data: {
            projectId,
            actorUserId: userId,
            action: "alert.acknowledge",
            entityType: "alert",
            entityId: alertId,
            details: {},
          },
        });

        res.status(201).json({
          acknowledgement: {
            id: ack.id,
            actorUserId: ack.actorUserId,
            createdAt: ack.createdAt.toISOString(),
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // Force a retry of every undelivered message for this alert.
  // Resets attempts so the dispatcher will claim them again even after the soft limit.
  r.post(
    "/:alertId/retry",
    ...auth,
    requireMembership(prisma, "Responder", "projectId"),
    async (req, res, next) => {
      try {
        const projectId = param(req, "projectId");
        const alertId = param(req, "alertId");
        const userId = req.user!.id;
        const now = systemClock.now();

        const alert = await prisma.alert.findFirst({
          where: { id: alertId, projectId },
          include: {
            messages: {
              where: { deliveredAt: null },
            },
          },
        });
        if (!alert) return next(notFoundError());

        if (alert.messages.length === 0) {
          return next(
            conflictError("No undelivered messages to retry for this alert"),
          );
        }

        let reset = 0;
        for (const m of alert.messages) {
          const rows = await prisma.$executeRaw`
            UPDATE outbox_messages
               SET attempts = 0,
                   next_attempt_at = ${now},
                   lease_until = NULL,
                   last_error = NULL
             WHERE id = ${m.id}::uuid AND delivered_at IS NULL`;
          if (rows > 0) reset += 1;
        }

        await prisma.auditLog.create({
          data: {
            projectId,
            actorUserId: userId,
            action: "alert.retry",
            entityType: "alert",
            entityId: alertId,
            details: { messagesReset: reset },
          },
        });

        res.json({ reset });
      } catch (err) {
        next(err);
      }
    },
  );

  return r;
}
