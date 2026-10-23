import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "../../prisma/generated";
import type { Config } from "../config";
import { requireAuth, loadUser } from "../middleware/auth";
import { requireMembership } from "../middleware/permissions";
import { validateBody } from "../middleware/validate";
import {
  codesField,
  configIssues,
  createServiceSchema,
  intervalField,
} from "../core/service-config";
import { createService } from "../db/service-create";
import { encryptSecret } from "../core/secrets";
import { conflictError, notFoundError, validationError } from "../errors";
import { param } from "../http-params";
import { systemClock } from "../core/clock";
import { openIncidentIfNeeded } from "../db/incidents";
import { lockService, refreshStatus } from "../db/service-status";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
        const outcome = await createService(prisma, config, {
          projectId: param(req, "projectId"),
          actorUserId: req.user!.id,
          input: req.body as z.infer<typeof createServiceSchema>,
        });
        if (outcome.kind === "invalid")
          return next(validationError("Validation failed", outcome.issues));
        if (outcome.kind === "plan_limit")
          return next(conflictError(outcome.message));
        const service = outcome.service;

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
          const change = await refreshStatus(
            tx,
            {
              ...locked,
              isPublic: merged.isPublic,
              intervalSeconds: merged.intervalSeconds,
              failThreshold: merged.failThreshold,
              recoveryThreshold: merged.recoveryThreshold,
              slowThreshold: merged.slowThreshold,
              degradedMs: merged.degradedMs,
            },
            systemClock.now(),
            { at: systemClock.now() },
          );
          await openIncidentIfNeeded(tx, serviceId, change);
          const refreshed = await tx.service.findUniqueOrThrow({
            where: { id: serviceId },
          });
          return { service: refreshed, changed };
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

  // Configuration history. Owner only.
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
