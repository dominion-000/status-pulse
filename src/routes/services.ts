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
import { systemClock } from "../core/clock";
import { openIncidentIfNeeded } from "../db/incidents";
import { lockService, refreshStatus } from "../db/service-status";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INTERVALS = [30, 60, 120, 300, 600, 900, 1800, 3600] as const;

const intervalField = z
  .number()
  .int()
  .refine((n) => (INTERVALS as readonly number[]).includes(n), {
    message: `must be one of ${INTERVALS.join(", ")}`,
  });
const codesField = z.array(z.number().int().min(100).max(599)).min(1);

const createServiceSchema = z.object({
  name: z.string().min(1).max(120),
  url: z.string().min(1).max(2048),
  method: z.enum(["GET", "HEAD", "POST"]).default("GET"),
  intervalSeconds: intervalField,
  timeoutSeconds: z.number().int().positive(),
  expectedStatusCodes: codesField.default([200]),
  expectedBodyText: z.string().max(500).optional(),
  isPublic: z.boolean().default(false),
  credentials: z.string().max(2000).optional(),
  failThreshold: z.number().int().min(1).max(20).default(3),
  recoveryThreshold: z.number().int().min(1).max(20).default(2),
  slowThreshold: z.number().int().min(1).max(20).default(3),
  degradedMs: z.number().int().positive().optional(),
});

const patchServiceSchema = z
  .object({
    name: z.string().min(1).max(120),
    url: z.string().min(1).max(2048),
    method: z.enum(["GET", "HEAD", "POST"]),
    intervalSeconds: intervalField,
    timeoutSeconds: z.number().int().positive(),
    expectedStatusCodes: codesField,
    expectedBodyText: z.string().max(500).nullable(),
    isPublic: z.boolean(),
    credentials: z.string().min(1).max(2000).nullable(),
    failThreshold: z.number().int().min(1).max(20),
    recoveryThreshold: z.number().int().min(1).max(20),
    slowThreshold: z.number().int().min(1).max(20),
    degradedMs: z.number().int().positive().nullable(),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, {
    message: "at least one field is required",
  });

/** Rules that depend on more than one field, checked on the complete configuration. */
function configIssues(c: {
  url: string;
  intervalSeconds: number;
  timeoutSeconds: number;
}): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (c.timeoutSeconds >= c.intervalSeconds)
    issues.push({
      path: "timeoutSeconds",
      message: "must be less than intervalSeconds",
    });
  for (const m of checkServiceUrl(c.url).issues)
    issues.push({ path: "url", message: m });
  return issues;
}

const SNAPSHOT_FIELDS = [
  "name",
  "url",
  "method",
  "intervalSeconds",
  "timeoutSeconds",
  "expectedStatusCodes",
  "expectedBodyText",
  "isPublic",
  "failThreshold",
  "recoveryThreshold",
  "slowThreshold",
  "degradedMs",
] as const;

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

        const issues = configIssues(body);
        if (issues.length)
          return next(validationError("Validation failed", issues));

        const credentialsEnc = body.credentials
          ? new Uint8Array(
              encryptSecret(body.credentials, config.credentialsEncKey),
            )
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

  // Edit a service (SP-02.4, SP-02.8).
  r.patch(
    "/:serviceId",
    ...auth,
    requireMembership(prisma, "Owner", "projectId"),
    validateBody(patchServiceSchema),
    async (req, res, next) => {
      try {
        const projectId = param(req, "projectId");
        const serviceId = param(req, "serviceId");
        const body = req.body as z.infer<typeof patchServiceSchema>;
        if (!UUID.test(serviceId)) return next(notFoundError());

        const result = await prisma.$transaction(async (tx) => {
          const locked = await lockService(tx, serviceId);
          if (!locked || locked.projectId !== projectId) throw notFoundError();
          const current = await tx.service.findUniqueOrThrow({
            where: { id: serviceId },
          });

          const merged = {
            name: body.name ?? current.name,
            url: body.url ?? current.url,
            method: body.method ?? current.method,
            intervalSeconds: body.intervalSeconds ?? current.intervalSeconds,
            timeoutSeconds: body.timeoutSeconds ?? current.timeoutSeconds,
            expectedStatusCodes:
              body.expectedStatusCodes ?? current.expectedStatusCodes,
            expectedBodyText:
              body.expectedBodyText !== undefined
                ? body.expectedBodyText
                : current.expectedBodyText,
            isPublic: body.isPublic ?? current.isPublic,
            failThreshold: body.failThreshold ?? current.failThreshold,
            recoveryThreshold:
              body.recoveryThreshold ?? current.recoveryThreshold,
            slowThreshold: body.slowThreshold ?? current.slowThreshold,
            degradedMs:
              body.degradedMs !== undefined
                ? body.degradedMs
                : current.degradedMs,
          };
          const issues = configIssues(merged);
          if (issues.length) throw validationError("Validation failed", issues);

          const changed: string[] = SNAPSHOT_FIELDS.filter(
            (f) => JSON.stringify(merged[f]) !== JSON.stringify(current[f]),
          );
          let credentialsEnc: Uint8Array<ArrayBuffer> | null | undefined;
          if (typeof body.credentials === "string") {
            credentialsEnc = new Uint8Array(
              encryptSecret(body.credentials, config.credentialsEncKey),
            );
            changed.push("credentials");
          } else if (body.credentials === null && current.credentialsEnc) {
            credentialsEnc = null;
            changed.push("credentials");
          }
          if (changed.length === 0) return { service: current, changed };

          const version = current.version + 1;
          const hasCredentials =
            credentialsEnc !== undefined
              ? credentialsEnc !== null
              : current.credentialsEnc !== null;
          const service = await tx.service.update({
            where: { id: serviceId },
            data: {
              ...merged,
              ...(credentialsEnc !== undefined ? { credentialsEnc } : {}),
              version,
            },
          });
          await tx.serviceConfigVersion.create({
            data: {
              serviceId,
              version,
              snapshot: { ...merged, hasCredentials },
              actorUserId: req.user!.id,
            },
          });
          await tx.auditLog.create({
            data: {
              projectId,
              actorUserId: req.user!.id,
              action: "service.updated",
              entityType: "service",
              entityId: serviceId,
              details: { version, changed },
            },
          });
          return { service, changed };
        });
        res.json({
          service: serviceShape(result.service),
          changed: result.changed,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // Configuration history, Owner only.
  r.get(
    "/:serviceId/versions",
    ...auth,
    requireMembership(prisma, "Owner", "projectId"),
    async (req, res, next) => {
      try {
        const serviceId = param(req, "serviceId");
        if (!UUID.test(serviceId)) return next(notFoundError());
        const service = await prisma.service.findFirst({
          where: {
            id: serviceId,
            projectId: param(req, "projectId"),
            deletedAt: null,
          },
        });
        if (!service) return next(notFoundError());
        const rows = await prisma.serviceConfigVersion.findMany({
          where: { serviceId },
          orderBy: { version: "desc" },
        });
        res.json({
          versions: rows.map((v) => ({
            version: v.version,
            snapshot: v.snapshot,
            actorUserId: v.actorUserId,
            createdAt: v.createdAt.toISOString(),
          })),
        });
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
          // Lock first, then change the flag and let the status writer decide what is shown (SP-02.9, SP-04.7).
          const locked = await lockService(tx, service.id);
          if (!locked) throw notFoundError();
          await tx.service.update({
            where: { id: service.id },
            data: { enabled: false },
          });
          const now = systemClock.now();
          await refreshStatus(tx, { ...locked, enabled: false }, now, {
            at: now,
          });
          const s = await tx.service.findUniqueOrThrow({
            where: { id: service.id },
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
          const locked = await lockService(tx, service.id);
          if (!locked) throw notFoundError();
          await tx.service.update({
            where: { id: service.id },
            data: { enabled: true },
          });
          const now = systemClock.now();
          const change = await refreshStatus(
            tx,
            { ...locked, enabled: true },
            now,
            { at: now },
          );
          await openIncidentIfNeeded(tx, service.id, change);
          const s = await tx.service.findUniqueOrThrow({
            where: { id: service.id },
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
