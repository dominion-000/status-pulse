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
import { mountApiDocs } from "./docs";

export interface AppDeps {
  logStream?: { write(line: string): void };
  config?: Config;
  prisma?: PrismaClient;
}

const notFound: RequestHandler = (_req, res) => {
  res
    .status(404)
    .json({ error: { code: "NOT_FOUND", message: "Route not found" } });
};

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
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

/** CORS for separate frontends (StatusGrep UI, etc.). */
function corsMiddleware(origins: string[]): RequestHandler {
  const allow = new Set(origins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allow.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Idempotency-Key",
      );
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PATCH, PUT, DELETE, OPTIONS",
      );
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

function mountApi(
  app: express.Express,
  deps: Required<Pick<AppDeps, "config" | "prisma">>,
) {
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
  api.use("/projects/:projectId/alerts", alertRoutes(deps.prisma, deps.config));
  api.use("/projects/:projectId", planRoutes(deps.prisma, deps.config));
  api.use("/public", publicRoutes(deps.prisma));
  api.use("/admin", adminRoutes(deps.prisma, deps.config));
  app.use("/api/v1", api);
}

/** JSON API only. UI lives in a separate StatusGrep app. */
export function createApp(deps: AppDeps = {}) {
  const app = express();
  app.disable("x-powered-by");
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  if (Number.isInteger(hops) && hops > 0) app.set("trust proxy", hops);
  app.use(createRequestLogger(deps.logStream));
  if (deps.config?.corsOrigins.length) {
    app.use(corsMiddleware(deps.config.corsOrigins));
  }
  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  if (deps.config && deps.prisma) {
    mountApi(app, { config: deps.config, prisma: deps.prisma });
  }

  mountApiDocs(app);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
