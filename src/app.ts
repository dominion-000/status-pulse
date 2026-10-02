import express from "express";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { createRequestLogger } from "./logging";

export interface AppDeps {
  logStream?: { write(line: string): void };
}

const notFound: RequestHandler = (_req, res) => {
  res
    .status(404)
    .json({ error: { code: "NOT_FOUND", message: "Route not found" } });
};

// Every error leaves through the same envelope.
// Typed errors are mapped here as the API grows.
const errorHandler: ErrorRequestHandler = (_err, _req, res, _next) => {
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

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
