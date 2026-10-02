import morgan from "morgan";
import type { RequestHandler } from "express";

/**
 * Request logging. Logs the path only: the query string is dropped because
 * it can carry secrets (for example /public/verify?token=...). Request bodies
 * and authorization headers are never logged.
 */
morgan.token("safe-url", (req) => {
  const url = (req as { originalUrl?: string; url?: string }).originalUrl ?? req.url ?? "";
  return url.split("?")[0];
});

const FORMAT = ":method :safe-url :status :response-time ms";

export function createRequestLogger(stream?: { write(line: string): void }): RequestHandler {
  return morgan(FORMAT, stream ? { stream } : {});
}
