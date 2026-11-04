import { Router } from "express";
import type { PrismaClient } from "../../prisma/generated";
import type { Config } from "../config";
import { requireAuth, loadUser } from "../middleware/auth";
import { requireAdmin } from "../middleware/permissions";

/**
 * Platform administrator endpoints (SP-08.1, SP-08.4).
 * All routes require a valid access token belonging to a user with isAdmin = true.
 */
export function adminRoutes(prisma: PrismaClient, config: Config) {
  const r = Router();
  const auth = [requireAuth(config), loadUser(prisma), requireAdmin()];

  /** Scheduler failures recorded by the scheduler process. */
  r.get("/scheduler-failures", ...auth, async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const rows = await prisma.schedulerFailure.findMany({
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      res.json({
        failures: rows.map((f) => ({
          id: f.id,
          message: f.message,
          details: f.details,
          createdAt: f.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Check jobs with elevated attempt counts or non-terminal status
   * (worker retries / stuck leases).
   */
  r.get("/jobs", ...auth, async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const minAttempts = Math.max(Number(req.query.minAttempts) || 1, 0);
      const status =
        typeof req.query.status === "string" ? req.query.status : undefined;

      const where: {
        attempts?: { gte: number };
        status?: string;
      } = {};
      if (minAttempts > 0) where.attempts = { gte: minAttempts };
      if (status) where.status = status;

      const rows = await prisma.checkJob.findMany({
        where,
        orderBy: [{ attempts: "desc" }, { scheduledFor: "desc" }],
        take: limit,
        include: {
          service: { select: { id: true, name: true, projectId: true } },
        },
      });
      res.json({
        jobs: rows.map((j) => ({
          id: j.id,
          serviceId: j.serviceId,
          serviceName: j.service.name,
          projectId: j.service.projectId,
          scheduledFor: j.scheduledFor.toISOString(),
          status: j.status,
          attempts: j.attempts,
          leaseUntil: j.leaseUntil?.toISOString() ?? null,
          createdAt: j.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Outbox messages that have not been delivered (failed or still retrying).
   */
  r.get("/outbox", ...auth, async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const onlyFailed =
        req.query.failed === "1" || req.query.failed === "true";

      const rows = await prisma.outboxMessage.findMany({
        where: onlyFailed
          ? { deliveredAt: null, attempts: { gt: 0 } }
          : { deliveredAt: null },
        orderBy: [{ attempts: "desc" }, { createdAt: "desc" }],
        take: limit,
        select: {
          id: true,
          projectId: true,
          kind: true,
          alertId: true,
          recipientEmail: true,
          subject: true,
          attempts: true,
          lastError: true,
          nextAttemptAt: true,
          leaseUntil: true,
          deliveredAt: true,
          createdAt: true,
        },
      });
      res.json({
        messages: rows.map((m) => ({
          id: m.id,
          projectId: m.projectId,
          kind: m.kind,
          alertId: m.alertId,
          recipientEmail: m.recipientEmail,
          subject: m.subject,
          attempts: m.attempts,
          lastError: m.lastError,
          nextAttemptAt: m.nextAttemptAt.toISOString(),
          leaseUntil: m.leaseUntil?.toISOString() ?? null,
          deliveredAt: m.deliveredAt?.toISOString() ?? null,
          createdAt: m.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Audit trail. Optional filters: projectId, action, entityType, actorUserId.
   * Access-change style actions are membership.role_change, membership.invite, plan.upgrade, etc.
   */
  r.get("/audit", ...auth, async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const where: {
        projectId?: string;
        action?: string | { startsWith: string };
        entityType?: string;
        actorUserId?: string;
      } = {};
      if (typeof req.query.projectId === "string")
        where.projectId = req.query.projectId;
      if (typeof req.query.action === "string") where.action = req.query.action;
      if (typeof req.query.entityType === "string")
        where.entityType = req.query.entityType;
      if (typeof req.query.actorUserId === "string")
        where.actorUserId = req.query.actorUserId;
      if (
        req.query.accessChanges === "1" ||
        req.query.accessChanges === "true"
      ) {
        // Convenience filter for role / membership / plan changes
        where.action = { startsWith: "" }; // will be replaced below
      }

      let rows;
      if (
        req.query.accessChanges === "1" ||
        req.query.accessChanges === "true"
      ) {
        rows = await prisma.auditLog.findMany({
          where: {
            OR: [
              { action: { contains: "membership" } },
              { action: { contains: "role" } },
              { action: { contains: "plan" } },
              { action: { contains: "invite" } },
            ],
          },
          orderBy: { createdAt: "desc" },
          take: limit,
          include: {
            actor: { select: { id: true, email: true } },
          },
        });
      } else {
        rows = await prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: limit,
          include: {
            actor: { select: { id: true, email: true } },
          },
        });
      }

      res.json({
        entries: rows.map((e) => ({
          id: e.id,
          projectId: e.projectId,
          actorUserId: e.actorUserId,
          actorEmail: e.actor?.email ?? null,
          action: e.action,
          entityType: e.entityType,
          entityId: e.entityId,
          details: e.details,
          createdAt: e.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  /** Lightweight user list for operators. */
  r.get("/users", ...auth, async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const rows = await prisma.user.findMany({
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          email: true,
          name: true,
          isAdmin: true,
          createdAt: true,
        },
      });
      res.json({
        users: rows.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          isAdmin: u.isAdmin,
          createdAt: u.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  });


  r.post("/users/:userId/admin", ...auth, async (req, res, next) => {
    try {
      const userId = String(req.params.userId);
      const action = (req.body as { action?: string })?.action;
      if (action !== "grant" && action !== "revoke") {
        res.status(422).json({
          error: {
            code: "VALIDATION_ERROR",
            message: "action must be grant or revoke",
          },
        });
        return;
      }
      if (userId === req.user!.id && action === "revoke") {
        res.status(409).json({
          error: {
            code: "CONFLICT",
            message: "Cannot revoke your own admin access",
          },
        });
        return;
      }
      const target = await prisma.user.findUnique({ where: { id: userId } });
      if (!target) {
        res.status(404).json({
          error: { code: "NOT_FOUND", message: "User not found" },
        });
        return;
      }
      const updated = await prisma.user.update({
        where: { id: userId },
        data: { isAdmin: action === "grant" },
      });
      await prisma.outboxMessage.create({
        data: {
          kind: "admin_access",
          recipientEmail: updated.email,
          subject:
            action === "grant"
              ? "Platform admin access granted — StatusGrep"
              : "Platform admin access revoked — StatusGrep",
          body: [
            `Hello${updated.name ? ` ${updated.name}` : ""},`,
            "",
            action === "grant"
              ? "You were granted platform administrator access on Status Pulse / StatusGrep."
              : "Your platform administrator access was revoked.",
            "",
            "— StatusGrep",
          ].join("\n"),
        },
      });
      res.json({
        user: {
          id: updated.id,
          email: updated.email,
          isAdmin: updated.isAdmin,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
