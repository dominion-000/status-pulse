import path from "node:path";
import express from "express";
import type { ErrorRequestHandler, RequestHandler } from "express";
import type { PrismaClient } from "../prisma/generated";
import { createRequestLogger } from "./logging";
import type { Config } from "./config";
import { AppError } from "./errors";
import { authRoutes } from "./routes/auth";
import { projectRoutes } from "./routes/projects";
import { serviceRoutes } from "./routes/services";
import { resultRoutes } from "./routes/results";
import { statusRoutes } from "./routes/status";
import { incidentRoutes } from "./routes/incidents";
import { alertRoutes } from "./routes/alerts";
import { publicRoutes } from "./routes/public";
import { planRoutes } from "./routes/plans";
import { adminRoutes } from "./routes/admin";
import { uiRoutes } from "./ui/routes";

export interface AppDeps {
  logStream?: { write(line: string): void };
  config?: Config;
  prisma?: PrismaClient;
}

const notFound: RequestHandler = (req, res) => {
  const wantsHtml = (req.headers.accept ?? "").includes("text/html");
  if (wantsHtml) {
    res
      .status(404)
      .type("html")
      .send("<!doctype html><title>Not found</title><p>Not found</p>");
    return;
  }
  res
    .status(404)
    .json({ error: { code: "NOT_FOUND", message: "Route not found" } });
};

const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    const wantsHtml = (req.headers.accept ?? "").includes("text/html");
    if (wantsHtml && !req.path.startsWith("/api/")) {
      res
        .status(err.status)
        .type("html")
        .send(
          `<!doctype html><title>Error</title><p>${err.message}</p>`,
        );
      return;
    }
    const body: {
      error: { code: string; message: string; details?: unknown };
    } = {
      error: { code: err.code, message: err.message },
    };
    if (err.details !== undefined) body.error.details = err.details;
    res.status(err.status).json(body);
    return;
  }
  console.error(err);
  res
    .status(500)
    .json({ error: { code: "INTERNAL", message: "Unexpected error" } });
};

/** Mount the JSON API under /api/v1. */
function mountApi(app: express.Express, deps: Required<Pick<AppDeps, "config" | "prisma">>) {
  const api = express.Router();
  api.use("/auth", authRoutes(deps.prisma, deps.config));
  api.use("/projects", projectRoutes(deps.prisma, deps.config));
  api.use(
    "/projects/:projectId/services",
    serviceRoutes(deps.prisma, deps.config),
  );
  api.use(
    "/projects/:projectId/services/:serviceId/results",
    resultRoutes(deps.prisma, deps.config),
  );
  api.use(
    "/projects/:projectId/services/:serviceId",
    statusRoutes(deps.prisma, deps.config),
  );
  api.use(
    "/projects/:projectId/incidents",
    incidentRoutes(deps.prisma, deps.config),
  );
  api.use(
    "/projects/:projectId/alerts",
    alertRoutes(deps.prisma, deps.config),
  );
  api.use("/projects/:projectId", planRoutes(deps.prisma, deps.config));
  api.use("/public", publicRoutes(deps.prisma));
  api.use("/admin", adminRoutes(deps.prisma, deps.config));
  app.use("/api/v1", api);
}

export function createApp(deps: AppDeps = {}) {
  const app = express();
  app.disable("x-powered-by");
  // Behind Render's proxy set TRUST_PROXY_HOPS=1 so req.ip is the real client. The default trusts nothing, because
  // trusting a proxy that is not there would let a client choose its own address.
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  if (Number.isInteger(hops) && hops > 0) app.set("trust proxy", hops);
  app.use(createRequestLogger(deps.logStream));
  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Static UI assets (CSS).
  app.use(
    "/ui/assets",
    express.static(path.join(__dirname, "ui", "public"), {
      fallthrough: true,
      index: false,
    }),
  );

  if (deps.config && deps.prisma) {
    mountApi(app, { config: deps.config, prisma: deps.prisma });
    // Browser UI at /
    app.use(uiRoutes(deps.prisma, deps.config));
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
