import type { Request } from "express";
import { notFoundError } from "./errors";

/** Express params are string | string[]; Prisma and our code need a single string. */
export function param(req: Request, name: string): string {
  const v = req.params[name];
  if (typeof v !== "string" || v.length === 0) throw notFoundError();
  return v;
}
