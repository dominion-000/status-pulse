import { Router } from "express";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../prisma/generated";
import type { Config } from "../config";
import { systemClock } from "../core/clock";
import {
  defaultIncidentFlag,
  isActive,
  isIncidentPublic,
  isUpdatePublic,
  transitionIssue,
  type IncidentStatus,
} from "../core/incident";
import { lockService, type Tx } from "../db/service-status";
import { conflictError, notFoundError, validationError } from "../errors";
import { param } from "../http-params";
import { loadUser, requireAuth } from "../middleware/auth";
import { requireMembership } from "../middleware/permissions";
import { validateBody } from "../middleware/validate";

const STATUSES = [
  "Investigating",
  "Identified",
  "Monitoring",
  "Resolved",
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const openSchema = z.object({
  serviceId: z.string().regex(UUID, "must be a UUID"),
  title: z.string().trim().min(3).max(200),
});

// `status` is optional: leaving it out adds a note. When present it must be the next status, so a repeated or
// racing move is answered with 409.
const updateSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  status: z.enum(STATUSES).optional(),
  isPublic: z.boolean().default(false),
});

// Hiding is one-way (SP-05.5): the body can only say false, so no request can publish an incident again.
const listSchema = z.object({
  state: z.enum(["active", "resolved"]).optional(),
  serviceId: z.string().regex(UUID).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

type IncidentRow = Prisma.IncidentGetPayload<{
  include: { service: { select: { isPublic: true; name: true } } };
}>;
type UpdateRow = Prisma.IncidentUpdateGetPayload<object>;

// `isPublic` is always derived (core/incident.ts), never the stored flag, so what members see matches the status page.
function incidentView(i: IncidentRow) {
  return {
    id: i.id,
    serviceId: i.serviceId,
    serviceName: i.service.name,
    title: i.title,
    status: i.status,
    origin: i.origin,
    isPublic: isIncidentPublic(i.isPublic, i.service.isPublic),
    openedByUserId: i.openedByUserId,
    resolvedByUserId: i.resolvedByUserId,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
    resolvedAt: i.resolvedAt ? i.resolvedAt.toISOString() : null,
  };
}

function updateView(u: UpdateRow, i: IncidentRow) {
  return {
    id: u.id,
    status: u.status,
    message: u.message,
    isPublic: isUpdatePublic(u.isPublic, i.isPublic, i.service.isPublic),
    actorUserId: u.actorUserId,
    createdAt: u.createdAt.toISOString(),
  };
}

const withService = {
  service: { select: { isPublic: true, name: true } },
} as const;

/** Incidents of a project (SP-05). Mounted under /projects/:projectId/incidents. */
export function incidentRoutes(prisma: PrismaClient, config: Config): Router {
  const r = Router({ mergeParams: true });
  const auth = [requireAuth(config), loadUser(prisma)];

  function incidentId(req: Parameters<typeof param>[0]): string {
    const id = param(req, "incidentId");
    if (!UUID.test(id)) throw notFoundError();
    return id;
  }

  async function load(projectId: string, id: string) {
    const incident = await prisma.incident.findFirst({
      where: { id, projectId },
      include: withService,
    });
    if (!incident) throw notFoundError();
    return incident;
  }

  /** Locks the incident row so two responders cannot move the same incident at once. Null when it is not in the project. */
  async function lockIncident(tx: Tx, projectId: string, id: string) {
    const rows = await tx.$queryRaw<{ status: IncidentStatus }[]>`
      SELECT status FROM incidents
       WHERE id = ${id}::uuid AND project_id = ${projectId}::uuid
         FOR UPDATE`;
    return rows[0] ?? null;
  }

  r.get(
    "/",
    ...auth,
    requireMembership(prisma, "Viewer", "projectId"),
    async (req, res, next) => {
      try {
        const q = listSchema.safeParse(req.query);
        if (!q.success)
          throw validationError(
            "Validation failed",
            q.error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          );
        const rows = await prisma.incident.findMany({
          where: {
            projectId: param(req, "projectId"),
            ...(q.data.serviceId ? { serviceId: q.data.serviceId } : {}),
            ...(q.data.state === "active"
              ? { status: { not: "Resolved" } }
              : q.data.state === "resolved"
                ? { status: "Resolved" }
                : {}),
          },
          include: withService,
          orderBy: { createdAt: "desc" },
          take: q.data.limit,
        });
        res.json({ incidents: rows.map(incidentView) });
      } catch (err) {
        next(err);
      }
    },
  );

  r.get(
    "/:incidentId",
    ...auth,
    requireMembership(prisma, "Viewer", "projectId"),
    async (req, res, next) => {
      try {
        const incident = await load(param(req, "projectId"), incidentId(req));
        const updates = await prisma.incidentUpdate.findMany({
          where: { incidentId: incident.id },
          orderBy: { createdAt: "asc" },
        });
        res.json({
          incident: {
            ...incidentView(incident),
            updates: updates.map((u) => updateView(u, incident)),
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // Manual open. The service row lock orders this against the worker and the sweeper, which open
  // automatic incidents under the same lock; the partial unique index stays for safety.
  r.post(
    "/",
    ...auth,
    requireMembership(prisma, "Responder", "projectId"),
    validateBody(openSchema),
    async (req, res, next) => {
      try {
        const projectId = param(req, "projectId");
        const body = req.body as z.infer<typeof openSchema>;
        let createdId = "";
        try {
          await prisma.$transaction(async (tx) => {
            const service = await lockService(tx, body.serviceId);
            if (!service || service.projectId !== projectId)
              throw notFoundError("Service not found");
            const active = await tx.incident.findFirst({
              where: { serviceId: service.id, status: { not: "Resolved" } },
            });
            if (active)
              throw conflictError(
                "This service already has an active incident",
              );
            const created = await tx.incident.create({
              data: {
                projectId,
                serviceId: service.id,
                title: body.title,
                origin: "manual",
                isPublic: defaultIncidentFlag(service.isPublic),
                openedByUserId: req.user!.id,
              },
            });
            createdId = created.id;
            await tx.auditLog.create({
              data: {
                projectId,
                actorUserId: req.user!.id,
                action: "incident.opened",
                entityType: "incident",
                entityId: created.id,
                details: { serviceId: service.id, origin: "manual" },
              },
            });
          });
        } catch (err) {
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === "P2002"
          )
            throw conflictError("This service already has an active incident");
          throw err;
        }
        res.status(201).json({
          incident: incidentView(await load(projectId, createdId)),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // Add an update, optionally moving the incident to its next status (SP-05.3, SP-05.4, SP-05.6).
  r.post(
    "/:incidentId/updates",
    ...auth,
    requireMembership(prisma, "Responder", "projectId"),
    validateBody(updateSchema),
    async (req, res, next) => {
      try {
        const projectId = param(req, "projectId");
        const id = incidentId(req);
        const body = req.body as z.infer<typeof updateSchema>;
        const now = systemClock.now();

        await prisma.$transaction(async (tx) => {
          const locked = await lockIncident(tx, projectId, id);
          if (!locked) throw notFoundError();
          if (!isActive(locked.status))
            throw conflictError("The incident is resolved; it is closed");

          const target = body.status ?? locked.status;
          const moves = body.status !== undefined;
          if (body.status !== undefined) {
            const issue = transitionIssue(locked.status, body.status);
            if (issue) throw conflictError(issue);
          }

          await tx.incidentUpdate.create({
            data: {
              incidentId: id,
              status: target,
              message: body.message,
              isPublic: body.isPublic,
              actorUserId: req.user!.id,
            },
          });
          if (moves) {
            await tx.incident.update({
              where: { id },
              data:
                target === "Resolved"
                  ? {
                      status: target,
                      resolvedAt: now,
                      resolvedByUserId: req.user!.id,
                    }
                  : { status: target },
            });
          } else {
            await tx.incident.update({ where: { id }, data: {} });
          }
          await tx.auditLog.create({
            data: {
              projectId,
              actorUserId: req.user!.id,
              action: moves ? "incident.status_changed" : "incident.noted",
              entityType: "incident",
              entityId: id,
              details: { from: locked.status, to: target },
            },
          });
        });

        const incident = await load(projectId, id);
        const updates = await prisma.incidentUpdate.findMany({
          where: { incidentId: id },
          orderBy: { createdAt: "asc" },
        });
        res.status(201).json({
          incident: {
            ...incidentView(incident),
            updates: updates.map((u) => updateView(u, incident)),
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // Hide from the status page. Owner only and one-way (SP-05.5): there is no route that makes an incident public.
  r.post(
    "/:incidentId/hide",
    ...auth,
    requireMembership(prisma, "Owner", "projectId"),
    async (req, res, next) => {
      try {
        const projectId = param(req, "projectId");
        const id = incidentId(req);
        await prisma.$transaction(async (tx) => {
          const locked = await lockIncident(tx, projectId, id);
          if (!locked) throw notFoundError();
          const current = await tx.incident.findUniqueOrThrow({
            where: { id },
          });
          if (!current.isPublic) return; // already hidden: nothing to change, nothing to audit
          await tx.incident.update({
            where: { id },
            data: { isPublic: false },
          });
          await tx.auditLog.create({
            data: {
              projectId,
              actorUserId: req.user!.id,
              action: "incident.hidden",
              entityType: "incident",
              entityId: id,
              details: {},
            },
          });
        });
        res.json({ incident: incidentView(await load(projectId, id)) });
      } catch (err) {
        next(err);
      }
    },
  );

  return r;
}
