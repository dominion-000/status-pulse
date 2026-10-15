import { Router } from "express";
import type { PrismaClient } from "../../prisma/generated";
import {
  isIncidentPublic,
  isUpdatePublic,
  type IncidentStatus,
} from "../core/incident";
import { notFoundError } from "../errors";
import { param } from "../http-params";

const HISTORY_LIMIT = 20;
const UPDATE_LIMIT = 20;

/**
 * Public status page (SP-07.1, SP-07.2).
 * Mounted at /public/:projectSlug. No authentication.
 * Only public, enabled services appear. Credentials, team details and internal
 * notes never appear in the response.
 */
export function publicRoutes(prisma: PrismaClient): Router {
  const r = Router();

  r.get("/:projectSlug", async (req, res, next) => {
    try {
      const slug = param(req, "projectSlug");

      const project = await prisma.project.findUnique({
        where: { slug },
        select: {
          id: true,
          name: true,
          slug: true,
          services: {
            where: {
              isPublic: true,
              enabled: true,
              deletedAt: null,
            },
            orderBy: { name: "asc" },
            select: {
              id: true,
              name: true,
              currentStatus: true,
              statusSince: true,
              lastResultAt: true,
              isPublic: true,
              incidents: {
                where: { status: { not: "Resolved" } },
                orderBy: { createdAt: "desc" },
                take: 1,
                select: {
                  id: true,
                  title: true,
                  status: true,
                  isPublic: true,
                  createdAt: true,
                  updates: {
                    orderBy: { createdAt: "asc" },
                    take: UPDATE_LIMIT,
                    select: {
                      id: true,
                      status: true,
                      message: true,
                      isPublic: true,
                      createdAt: true,
                    },
                  },
                },
              },
              statusHistory: {
                orderBy: { startedAt: "desc" },
                take: HISTORY_LIMIT,
                select: {
                  status: true,
                  computedStatus: true,
                  source: true,
                  startedAt: true,
                },
              },
            },
          },
        },
      });

      if (!project) return next(notFoundError());

      res.json({
        project: {
          name: project.name,
          slug: project.slug,
        },
        services: project.services.map((s) => {
          const rawIncident = s.incidents[0] ?? null;
          const incidentPublic =
            rawIncident &&
            isIncidentPublic(rawIncident.isPublic, s.isPublic);

          return {
            id: s.id,
            name: s.name,
            currentStatus: s.currentStatus,
            statusSince: s.statusSince.toISOString(),
            lastResultAt: s.lastResultAt
              ? s.lastResultAt.toISOString()
              : null,
            activeIncident: incidentPublic
              ? {
                  id: rawIncident!.id,
                  title: rawIncident!.title,
                  status: rawIncident!.status as IncidentStatus,
                  createdAt: rawIncident!.createdAt.toISOString(),
                  updates: rawIncident!.updates
                    .filter((u) =>
                      isUpdatePublic(
                        u.isPublic,
                        rawIncident!.isPublic,
                        s.isPublic,
                      ),
                    )
                    .map((u) => ({
                      id: u.id,
                      status: u.status as IncidentStatus,
                      message: u.message,
                      createdAt: u.createdAt.toISOString(),
                    })),
                }
              : null,
            recentHistory: s.statusHistory.map((h) => ({
              status: h.status,
              computedStatus: h.computedStatus,
              source: h.source,
              startedAt: h.startedAt.toISOString(),
            })),
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
