import { Router } from "express";
import type { PrismaClient } from "../../prisma/generated";
import type { Config } from "../config";
import { requireAuth, loadUser } from "../middleware/auth";
import { requireMembership } from "../middleware/permissions";
import { param } from "../http-params";

/**
 * Server-Sent Events for live service status.
 * GET /api/v1/projects/:projectId/events/status
 */
export function eventsRoutes(prisma: PrismaClient, config: Config): Router {
  const r = Router({ mergeParams: true });
  const auth = [requireAuth(config), loadUser(prisma)];

  r.get(
    "/status",
    ...auth,
    requireMembership(prisma, "Viewer"),
    async (req, res, next) => {
      try {
        const projectId = param(req, "projectId");
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        if (typeof res.flushHeaders === "function") res.flushHeaders();

        let closed = false;
        const stop = () => {
          closed = true;
        };
        req.on("close", stop);

        const tick = async () => {
          if (closed) return;
          const services = await prisma.service.findMany({
            where: { projectId, deletedAt: null },
            select: {
              id: true,
              name: true,
              enabled: true,
              currentStatus: true,
              statusSince: true,
              lastResultAt: true,
            },
            orderBy: { name: "asc" },
          });
          const payload = {
            at: new Date().toISOString(),
            services: services.map((s) => ({
              id: s.id,
              name: s.name,
              enabled: s.enabled,
              status: s.currentStatus,
              statusSince: s.statusSince.toISOString(),
              lastResultAt: s.lastResultAt?.toISOString() ?? null,
            })),
          };
          res.write(`event: status\ndata: ${JSON.stringify(payload)}\n\n`);
        };

        await tick();
        const id = setInterval(() => {
          void tick().catch((err) => console.error("sse tick", err));
        }, 4000);

        req.on("close", () => {
          clearInterval(id);
          stop();
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return r;
}
