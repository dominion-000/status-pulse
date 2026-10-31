import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "../../prisma/generated";
import {
  isIncidentPublic,
  isUpdatePublic,
  type IncidentStatus,
} from "../core/incident";
import { exposeVerificationToken } from "../core/tokens";
import { notFoundError, validationError } from "../errors";
import { param } from "../http-params";
import { rateLimit, subscribeRateLimitStore } from "../middleware/rate-limit";
import { validateBody } from "../middleware/validate";
import { subscribeToPublicProject, verifySubscription } from "../db/subscribe";
import { cacheGet, cacheSet, publicStatusKey } from "../core/cache";

const HISTORY_LIMIT = 20;
const UPDATE_LIMIT = 20;
const subscribeSchema = z.object({
  email: z.string().email().max(320),
  serviceIds: z.array(z.string().uuid()).min(1).max(50),
});

const verifySchema = z.object({
  token: z.string().min(16).max(128),
});

/**
 * Public status page, subscribe and verify (SP-07).
 * Mounted at /public. No authentication on these routes.
 */
export function publicRoutes(prisma: PrismaClient): Router {
  const r = Router();

  r.get("/:projectSlug", async (req, res, next) => {
    try {
      const slug = param(req, "projectSlug");
      const cacheKey = publicStatusKey(slug);
      const cached = await cacheGet(cacheKey);
      if (cached) {
        res.setHeader("X-Cache", "HIT");
        res.type("json").send(cached);
        return;
      }
      const project = await prisma.project.findUnique({
        where: { slug },
        select: {
          id: true,
          name: true,
          slug: true,
          services: {
            where: { isPublic: true, enabled: true, deletedAt: null },
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
                select: { status: true, startedAt: true },
              },
            },
          },
        },
      });
      if (!project) return next(notFoundError());
      const body = {
        project: { name: project.name, slug: project.slug },
        services: project.services.map((s) => {
          const rawIncident = s.incidents[0] ?? null;
          const incidentPublic =
            rawIncident && isIncidentPublic(rawIncident.isPublic, s.isPublic);
          return {
            id: s.id,
            name: s.name,
            currentStatus: s.currentStatus,
            statusSince: s.statusSince.toISOString(),
            lastResultAt: s.lastResultAt ? s.lastResultAt.toISOString() : null,
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
            // Only the shown status. The computed status and the source would reveal what an override hides.
            recentHistory: s.statusHistory.map((h) => ({
              status: h.status,
              startedAt: h.startedAt.toISOString(),
            })),
          };
        }),
      };
      const payload = JSON.stringify(body);
      await cacheSet(cacheKey, payload);
      res.setHeader("X-Cache", "MISS");
      res.type("json").send(payload);
    } catch (err) {
      next(err);
    }
  });

  r.post(
    "/:projectSlug/subscribe",
    rateLimit({ name: "subscribe", store: subscribeRateLimitStore }),
    validateBody(subscribeSchema),
    async (req, res, next) => {
      try {
        const slug = param(req, "projectSlug");
        const { email, serviceIds } = req.body as z.infer<
          typeof subscribeSchema
        >;

        const result = await subscribeToPublicProject(prisma, {
          projectSlug: slug,
          email,
          serviceIds,
        });

        if (!result.ok) {
          if (result.reason === "project_not_found")
            return next(notFoundError());
          if (result.reason === "no_public_services") {
            return next(
              validationError(
                "at least one public enabled service is required",
                [
                  {
                    path: "serviceIds",
                    message: "at least one public enabled service is required",
                  },
                ],
              ),
            );
          }
          return next(
            validationError(
              "one or more services are not public or not found",
              [
                {
                  path: "serviceIds",
                  message: "one or more services are not public or not found",
                },
              ],
            ),
          );
        }

        if (result.alreadyVerified) {
          res.status(201).json({
            subscriber: { email: email.trim().toLowerCase(), verified: true },
          });
          return;
        }

        const body: {
          subscriber: { id: string; email: string; verified: boolean };
          verificationToken?: string;
        } = {
          subscriber: {
            id: result.subscriberId,
            email: result.email,
            verified: false,
          },
        };
        if (exposeVerificationToken()) {
          body.verificationToken = result.verificationToken;
        }
        res.status(201).json(body);
      } catch (err) {
        next(err);
      }
    },
  );

  r.post(
    "/subscriptions/verify",
    validateBody(verifySchema),
    async (req, res, next) => {
      try {
        const { token } = req.body as z.infer<typeof verifySchema>;
        const result = await verifySubscription(prisma, { token });
        if (!result.ok) {
          return res.status(410).json({
            error: {
              code: "GONE",
              message: "Verification token is invalid or has already been used",
            },
          });
        }
        res.json({
          subscriber: {
            id: result.subscriber.id,
            email: result.subscriber.email,
            verified: true,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return r;
}
