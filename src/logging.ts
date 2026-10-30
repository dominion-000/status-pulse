import { randomUUID } from "node:crypto";
import morgan from "morgan";
import type { RequestHandler } from "express";
import { log } from "./core/log";

/**
 * HTTP request logging with Morgan.
 * Path only (query stripped — tokens live there). Bodies/Authorization never logged.
 * Request id on X-Request-Id.
 */
morgan.token("safe-url", (req) => {
  const url =
    (req as { originalUrl?: string; url?: string }).originalUrl ??
    req.url ??
    "";
  return url.split("?")[0] ?? "";
});

morgan.token("request-id", (req) => {
  return (req as { requestId?: string }).requestId ?? "-";
});

const FORMAT =
  ':method :safe-url :status :response-time ms rid=:request-id';

export function createRequestLogger(stream?: {
  write(line: string): void;
}): RequestHandler {
  const assignId: RequestHandler = (req, res, next) => {
    const incoming = req.headers["x-request-id"];
    const id =
      typeof incoming === "string" &&
      incoming.length > 0 &&
      incoming.length < 128
        ? incoming
        : randomUUID();
    (req as { requestId?: string }).requestId = id;
    res.setHeader("X-Request-Id", id);
    next();
  };

  const access = morgan(FORMAT, {
    stream: stream ?? {
      write(raw: string) {
        const line = raw.trimEnd();
        // Access log via Winston as http level + stdout for classic one-liners
        log.http(line);
      },
    },
  });

  const chained: RequestHandler = (req, res, next) => {
    assignId(req, res, (err?: unknown) => {
      if (err) return next(err as Error);
      access(req, res, next);
    });
  };
  return chained;
}
