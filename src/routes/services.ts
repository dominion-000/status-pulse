import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "../../prisma/generated";
import type { Config } from "../config";
import { requireAuth, loadUser } from "../middleware/auth";
import { requireMembership } from "../middleware/permissions";
import { validateBody } from "../middleware/validate";
import { checkServiceUrl } from "../core/url-safety";
import { encryptSecret } from "../core/secrets";
import { notFoundError, validationError } from "../errors";
import { param } from "../http-params";

const INTERVALS = [30, 60, 120, 300, 600, 900, 1800, 3600] as const;

const createServiceSchema = z.object({
  name: z.string().min(1).max(120),
  url: z.string().min(1).max(2048),
  method: z.enum(["GET", "HEAD", "POST"]).default("GET"),
  intervalSeconds: z.number().int().refine((n) => (INTERVALS as readonly number[]).includes(n), {
    message: `must be one of ${INTERVALS.join(", ")}`,
  }),
  timeoutSeconds: z.number().int().positive(),
  expectedStatusCodes: z.array(z.number().int().min(100).max(599)).min(1).default([200]),
  expectedBodyText: z.string().max(500).optional(),
  isPublic: z.boolean().default(false),
  credentials: z.string().max(2000).optional(),
  failThreshold: z.number().int().min(1).max(20).default(3),
  recoveryThreshold: z.number().int().min(1).max(20).default(2),
  slowThreshold: z.number().int().min(1).max(20).default(3),
  degradedMs: z.number().int().positive().optional(),
});

function serviceShape(s: {
  id: string;
  projectId: string;
  name: string;
  url: string;
  method: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  expectedStatusCodes: number[];
  expectedBodyText: string | null;
  isPublic: boolean;
  enabled: boolean;
  failThreshold: number;
  recoveryThreshold: number;
  slowThreshold: number;
  degradedMs: number | null;
  currentStatus: string;
  statusSince: Date;
  version: number;
  createdAt: Date;
}) {
  return {
    id: s.id,
    projectId: s.projectId,
    name: s.name,
    url: s.url,
    method: s.method,
    intervalSeconds: s.intervalSeconds,
    timeoutSeconds: s.timeoutSeconds,
    expectedStatusCodes: s.expectedStatusCodes,
    expectedBodyText: s.expectedBodyText,
    isPublic: s.isPublic,
    enabled: s.enabled,
    failThreshold: s.failThreshold,
    recoveryThreshold: s.recoveryThreshold,
    slowThreshold: s.slowThreshold,
    degradedMs: s.degradedMs,
    currentStatus: s.currentStatus,
    statusSince: s.statusSince.toISOString(),
    version: s.version,
    createdAt: s.createdAt.toISOString(),
  };
}

export function serviceRoutes(prisma: PrismaClient, config: Config): Router {
  const r = Router({ mergeParams: true });
  const auth = [requireAuth(config), loadUser(prisma)];

  r.post(
    "/",
    ...auth,
    requireMembership(prisma, "Owner", "projectId"),
    validateBody(createServiceSchema),
    async (req, res, next) => {
      try {
        const body = req.body as z.infer<typeof createServiceSchema>;
        const projectId = param(req, "projectId");

        if (body.timeoutSeconds >= body.intervalSeconds) {
          return next(
            validationError("Validation failed", [
              { path: "timeoutSeconds", message: "must be less than intervalSeconds" },
            ]),
          );
        }

        const urlCheck = checkServiceUrl(body.url);
        if (urlCheck.issues.length) {
          return next(
            validationError(
              "Validation failed",
              urlCheck.issues.map((m) => ({ path: "url", message: m })),
            ),
          );
        }

        const credentialsEnc = body.credentials
          ? new Uint8Array(encryptSecret(body.credentials, config.credentialsEncKey))
          : null;

        const snapshot = {
          name: body.name,
          url: body.url,
          method: body.method,
          intervalSeconds: body.intervalSeconds,
          timeoutSeconds: body.timeoutSeconds,
          expectedStatusCodes: body.expectedStatusCodes,
          expectedBodyText: body.expectedBodyText ?? null,
          isPublic: body.isPublic,
          failThreshold: body.failThreshold,
          recoveryThreshold: body.recoveryThreshold,
          slowThreshold: body.slowThreshold,
          degradedMs: body.degradedMs ?? null,
        };

        const service = await prisma.$transaction(async (tx) => {
          const s = await tx.service.create({
            data: {
              projectId,
              name: body.name,
              url: body.url,
              method: body.method,
              intervalSeconds: body.intervalSeconds,
              timeoutSeconds: body.timeoutSeconds,
              expectedStatusCodes: body.expectedStatusCodes,
              expectedBodyText: body.expectedBodyText ?? null,
              isPublic: body.isPublic,
              credentialsEnc,
              failThreshold: body.failThreshold,
              recoveryThreshold: body.recoveryThreshold,
              slowThreshold: body.slowThreshold,
              degradedMs: body.degradedMs ?? null,
              version: 1,
            },
          });
          await tx.serviceConfigVersion.create({
            data: {
              serviceId: s.id,
              version: 1,
              snapshot,
              actorUserId: req.user!.id,
            },
          });
          await tx.auditLog.create({
            data: {
              projectId,
              actorUserId: req.user!.id,
              action: "service.created",
              entityType: "service",
              entityId: s.id,
              details: { name: body.name, url: body.url },
            },
          });
          return s;
        });

        res.status(201).json({ service: serviceShape(service) });
      } catch (err) {
        next(err);
      }
    },
  );

  r.get(
    "/",
    ...auth,
    requireMembership(prisma, "Viewer", "projectId"),
    async (req, res, next) => {
      try {
        const projectId = param(req, "projectId");
        const services = await prisma.service.findMany({
          where: { projectId, deletedAt: null },
          orderBy: { createdAt: "asc" },
        });
        res.json({ services: services.map(serviceShape) });
      } catch (err) {
        next(err);
      }
    },
  );

  r.get(
    "/:serviceId",
    ...auth,
    requireMembership(prisma, "Viewer", "projectId"),
    async (req, res, next) => {
      try {
        const service = await prisma.service.findFirst({
          where: {
            id: param(req, "serviceId"),
            projectId: param(req, "projectId"),
            deletedAt: null,
          },
        });
        if (!service) return next(notFoundError());
        res.json({ service: serviceShape(service) });
      } catch (err) {
        next(err);
      }
    },
  );

  r.post(
    "/:serviceId/disable",
    ...auth,
    requireMembership(prisma, "Owner", "projectId"),
    async (req, res, next) => {
      try {
        const service = await prisma.service.findFirst({
          where: {
            id: param(req, "serviceId"),
            projectId: param(req, "projectId"),
            deletedAt: null,
          },
        });
        if (!service) return next(notFoundError());

        const updated = await prisma.$transaction(async (tx) => {
          const s = await tx.service.update({
            where: { id: service.id },
            data: { enabled: false, currentStatus: "Unknown", statusSince: new Date() },
          });
          await tx.auditLog.create({
            data: {
              projectId: service.projectId,
              actorUserId: req.user!.id,
              action: "service.disabled",
              entityType: "service",
              entityId: service.id,
            },
          });
          return s;
        });
        res.json({ service: serviceShape(updated) });
      } catch (err) {
        next(err);
      }
    },
  );

  r.post(
    "/:serviceId/enable",
    ...auth,
    requireMembership(prisma, "Owner", "projectId"),
    async (req, res, next) => {
      try {
        const service = await prisma.service.findFirst({
          where: {
            id: param(req, "serviceId"),
            projectId: param(req, "projectId"),
            deletedAt: null,
          },
        });
        if (!service) return next(notFoundError());

        const updated = await prisma.$transaction(async (tx) => {
          const s = await tx.service.update({
            where: { id: service.id },
            data: { enabled: true },
          });
          await tx.auditLog.create({
            data: {
              projectId: service.projectId,
              actorUserId: req.user!.id,
              action: "service.enabled",
              entityType: "service",
              entityId: service.id,
            },
          });
          return s;
        });
        res.json({ service: serviceShape(updated) });
      } catch (err) {
        next(err);
      }
    },
  );

  return r;
}
