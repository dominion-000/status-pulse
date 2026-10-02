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
    const body: { error: { code: string; message: string; details?: unknown } } = {
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

export function createApp(deps: AppDeps = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(createRequestLogger(deps.logStream));
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  if (deps.config && deps.prisma) {
    app.use("/auth", authRoutes(deps.prisma, deps.config));
    app.use("/projects", projectRoutes(deps.prisma, deps.config));
    app.use(
      "/projects/:projectId/services",
      serviceRoutes(deps.prisma, deps.config),
    );
    app.use(
      "/projects/:projectId/services/:serviceId/results",
      resultRoutes(deps.prisma, deps.config),
    );
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
