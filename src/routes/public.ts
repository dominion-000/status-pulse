import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "../../prisma/generated";
import {
  isIncidentPublic,
  isUpdatePublic,
  type IncidentStatus,
} from "../core/incident";
import {
  createVerificationToken,
  exposeVerificationToken,
  hashToken,
} from "../core/tokens";
import { systemClock } from "../core/clock";
import { notFoundError, validationError } from "../errors";
import { param } from "../http-params";
import { rateLimit, sharedAuthRateLimitStore } from "../middleware/rate-limit";
import { validateBody } from "../middleware/validate";

const HISTORY_LIMIT = 20;
const UPDATE_LIMIT = 20;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

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
      res.json({
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
      });
    } catch (err) {
      next(err);
    }
  });

  r.post(
    "/:projectSlug/subscribe",
    rateLimit({ name: "auth", store: sharedAuthRateLimitStore }),
    validateBody(subscribeSchema),
    async (req, res, next) => {
      try {
        const slug = param(req, "projectSlug");
        const { email: rawEmail, serviceIds } = req.body as z.infer<
          typeof subscribeSchema
        >;
        // One subscriber per address, whatever the letter case: "A@x.io" and "a@x.io" are the same mailbox.
        const email = rawEmail.trim().toLowerCase();
        const now = systemClock.now();
        const project = await prisma.project.findUnique({
          where: { slug },
          select: { id: true, name: true },
        });
        if (!project) return next(notFoundError());

        const publicServices = await prisma.service.findMany({
          where: {
            projectId: project.id,
            id: { in: serviceIds },
            isPublic: true,
            enabled: true,
            deletedAt: null,
          },
          select: { id: true, name: true },
        });
        if (publicServices.length === 0) {
          return next(
            validationError("at least one public enabled service is required", [
              {
                path: "serviceIds",
                message: "at least one public enabled service is required",
              },
            ]),
          );
        }
        if (publicServices.length !== serviceIds.length) {
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

        const { raw, hash } = createVerificationToken();
        const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

        const result = await prisma.$transaction(async (tx) => {
          let subscriber = await tx.subscriber.findUnique({
            where: { projectId_email: { projectId: project.id, email } },
          });

          if (subscriber?.verifiedAt) {
            for (const svc of publicServices) {
              await tx.subscriberService.upsert({
                where: {
                  subscriberId_serviceId: {
                    subscriberId: subscriber.id,
                    serviceId: svc.id,
                  },
                },
                create: { subscriberId: subscriber.id, serviceId: svc.id },
                update: {},
              });
            }
            return { subscriber, created: false, token: null as string | null };
          }

          if (!subscriber) {
            subscriber = await tx.subscriber.create({
              data: {
                projectId: project.id,
                email,
                verificationTokenHash: hash,
                verificationExpiresAt: expiresAt,
              },
            });
          } else {
            subscriber = await tx.subscriber.update({
              where: { id: subscriber.id },
              data: {
                verificationTokenHash: hash,
                verificationExpiresAt: expiresAt,
              },
            });
          }

          for (const svc of publicServices) {
            await tx.subscriberService.upsert({
              where: {
                subscriberId_serviceId: {
                  subscriberId: subscriber.id,
                  serviceId: svc.id,
                },
              },
              create: { subscriberId: subscriber.id, serviceId: svc.id },
              update: {},
            });
          }

          const serviceNames = publicServices.map((s) => s.name).join(", ");
          await tx.outboxMessage.create({
            data: {
              projectId: project.id,
              kind: "subscription_verification",
              recipientEmail: email,
              subject: `Verify your subscription to ${project.name}`,
              body:
                `Confirm your subscription to ${serviceNames} in ${project.name}. ` +
                `Use this verification token: ${raw}`,
            },
          });
          return { subscriber, created: true, token: raw };
        });

        res.status(result.created ? 201 : 200).json({
          subscriber: {
            id: result.subscriber.id,
            email: result.subscriber.email,
            verified: result.subscriber.verifiedAt != null,
          },
          // The token proves the caller reads that mailbox, so it is not returned in production (core/tokens.ts).
          ...(result.token && exposeVerificationToken()
            ? { verificationToken: result.token }
            : {}),
        });
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
        const hash = hashToken(token);
        const now = systemClock.now();
        const subscriber = await prisma.subscriber.findFirst({
          where: { verificationTokenHash: hash },
        });
        if (
          !subscriber ||
          !subscriber.verificationExpiresAt ||
          subscriber.verificationExpiresAt.getTime() < now.getTime() ||
          subscriber.verifiedAt
        ) {
          return res.status(410).json({
            error: {
              code: "GONE",
              message: "Verification token is invalid or has already been used",
            },
          });
        }
        // The token is single-use: the update applies only while it is still unused, so of two simultaneous
        // requests with the same token exactly one succeeds.
        const claimed = await prisma.subscriber.updateMany({
          where: {
            id: subscriber.id,
            verificationTokenHash: hash,
            verifiedAt: null,
            verificationExpiresAt: { gte: now },
          },
          data: {
            verifiedAt: now,
            verificationTokenHash: null,
            verificationExpiresAt: null,
          },
        });
        if (claimed.count !== 1) {
          return res.status(410).json({
            error: {
              code: "GONE",
              message: "Verification token is invalid or has already been used",
            },
          });
        }
        res.json({
          subscriber: {
            id: subscriber.id,
            email: subscriber.email,
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
