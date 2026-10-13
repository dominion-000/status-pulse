import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "../../prisma/generated";
import type { Config } from "../config";
import { systemClock } from "../core/clock";
import { openIncidentIfNeeded } from "../db/incidents";
import { lockService, refreshStatus } from "../db/service-status";
import { conflictError, notFoundError } from "../errors";
import { param } from "../http-params";
import { loadUser, requireAuth } from "../middleware/auth";
import { requireMembership } from "../middleware/permissions";
import { validateBody } from "../middleware/validate";

const STATUSES = ["Operational", "Degraded", "Outage", "Unknown"] as const;
const MAX_OVERRIDE_DAYS = 30;
const DAY_MS = 86_400_000;

const overrideSchema = z.object({
  status: z.enum(STATUSES),
  reason: z.string().trim().min(3).max(500),
  expiresAt: z.coerce
    .date()
    .refine((d) => d.getTime() > Date.now(), {
      message: "must be in the future",
    })
    .refine((d) => d.getTime() <= Date.now() + MAX_OVERRIDE_DAYS * DAY_MS, {
      message: `must be within ${MAX_OVERRIDE_DAYS} days`,
    }),
});

/** Status, history and manual overrides of one service (SP-04). Mounted under /projects/:projectId/services/:serviceId. */
export function statusRoutes(prisma: PrismaClient, config: Config): Router {
  const r = Router({ mergeParams: true });
  const auth = [requireAuth(config), loadUser(prisma)];

  async function findService(projectId: string, serviceId: string) {
    return prisma.service.findFirst({
      where: { id: serviceId, projectId, deletedAt: null },
    });
  }

  /** The status as members see it: what is shown, what the results say underneath, and any active override. */
  async function snapshot(projectId: string, serviceId: string) {
    const service = await findService(projectId, serviceId);
    if (!service) throw notFoundError();
    const override = await prisma.statusOverride.findFirst({
      where: { serviceId, endedAt: null, expiresAt: { gt: systemClock.now() } },
    });
    return {
      current: service.currentStatus,
      computed: service.computedStatus,
      since: service.statusSince.toISOString(),
      lastResultAt: service.lastResultAt
        ? service.lastResultAt.toISOString()
        : null,
      override: override
        ? {
            status: override.status,
            reason: override.reason,
            createdAt: override.createdAt.toISOString(),
            expiresAt: override.expiresAt.toISOString(),
          }
        : null,
    };
  }

  r.get(
    "/status",
    ...auth,
    requireMembership(prisma, "Viewer", "projectId"),
    async (req, res, next) => {
      try {
        res.json({
          status: await snapshot(
            param(req, "projectId"),
            param(req, "serviceId"),
          ),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  r.get(
    "/status/history",
    ...auth,
    requireMembership(prisma, "Viewer", "projectId"),
    async (req, res, next) => {
      try {
        const service = await findService(
          param(req, "projectId"),
          param(req, "serviceId"),
        );
        if (!service) return next(notFoundError());
        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
        const rows = await prisma.serviceStatusHistory.findMany({
          where: { serviceId: service.id },
          orderBy: { startedAt: "desc" },
          take: limit,
        });
        res.json({
          history: rows.map((h) => ({
            status: h.status,
            computedStatus: h.computedStatus,
            source: h.source,
            causedByResultId: h.causedByResultId,
            startedAt: h.startedAt.toISOString(),
          })),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // Set an override. Owner only. The row lock keeps it from racing a check result on the same service.
  r.post(
    "/override",
    ...auth,
    requireMembership(prisma, "Owner", "projectId"),
    validateBody(overrideSchema),
    async (req, res, next) => {
      try {
        const projectId = param(req, "projectId");
        const serviceId = param(req, "serviceId");
        const body = req.body as z.infer<typeof overrideSchema>;
        if (!(await findService(projectId, serviceId)))
          return next(notFoundError());
        const now = systemClock.now();

        await prisma.$transaction(async (tx) => {
          const service = await lockService(tx, serviceId);
          if (!service) throw notFoundError();
          if (!service.enabled)
            throw conflictError(
              "Enable the service before setting an override",
            );

          const active = await tx.statusOverride.findFirst({
            where: { serviceId, endedAt: null },
          });
          if (active && active.expiresAt > now)
            throw conflictError(
              "An override is already active; cancel it first",
            );
          // One that expired but has not been swept yet must not block a new one.
          if (active) {
            await tx.statusOverride.update({
              where: { id: active.id },
              data: { endedAt: active.expiresAt, endReason: "expired" },
            });
          }

          await tx.statusOverride.create({
            data: {
              serviceId,
              status: body.status,
              reason: body.reason,
              actorUserId: req.user!.id,
              expiresAt: body.expiresAt,
            },
          });
          await refreshStatus(tx, service, now, { at: now });
          await tx.auditLog.create({
            data: {
              projectId,
              actorUserId: req.user!.id,
              action: "status.override_set",
              entityType: "service",
              entityId: serviceId,
              details: {
                status: body.status,
                reason: body.reason,
                expiresAt: body.expiresAt.toISOString(),
              },
            },
          });
        });
        res.status(201).json({ status: await snapshot(projectId, serviceId) });
      } catch (err) {
        next(err);
      }
    },
  );

  // Cancel the active override. If the service is down underneath, the incident opens now.
  r.delete(
    "/override",
    ...auth,
    requireMembership(prisma, "Owner", "projectId"),
    async (req, res, next) => {
      try {
        const projectId = param(req, "projectId");
        const serviceId = param(req, "serviceId");
        if (!(await findService(projectId, serviceId)))
          return next(notFoundError());
        const now = systemClock.now();

        await prisma.$transaction(async (tx) => {
          const service = await lockService(tx, serviceId);
          if (!service) throw notFoundError();
          const active = await tx.statusOverride.findFirst({
            where: { serviceId, endedAt: null, expiresAt: { gt: now } },
          });
          if (!active) throw notFoundError("No active override");

          await tx.statusOverride.update({
            where: { id: active.id },
            data: {
              endedAt: now,
              endedByUserId: req.user!.id,
              endReason: "cancelled",
            },
          });
          const change = await refreshStatus(tx, service, now, { at: now });
          const incidentId = await openIncidentIfNeeded(tx, serviceId, change);
          await tx.auditLog.create({
            data: {
              projectId,
              actorUserId: req.user!.id,
              action: "status.override_cancelled",
              entityType: "service",
              entityId: serviceId,
              details: { incidentOpened: incidentId !== null },
            },
          });
        });
        res.json({ status: await snapshot(projectId, serviceId) });
      } catch (err) {
        next(err);
      }
    },
  );

  return r;
}
