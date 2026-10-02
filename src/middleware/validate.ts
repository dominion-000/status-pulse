import type { RequestHandler } from "express";
import { z } from "zod";
import { validationError } from "../errors";

/** Parse body with a Zod schema; on failure return 422 with structured details. */
export function validateBody<T extends z.ZodType>(schema: T): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }));
      return next(validationError("Validation failed", details));
    }
    req.body = result.data;
    next();
  };
}
