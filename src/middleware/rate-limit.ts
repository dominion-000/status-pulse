import type { RequestHandler } from "express";
import { AppError } from "../errors";

/**
 * Shared in-memory rate limiter for register, login and subscribe (SP-07.3).
 * Keyed by client IP. Suitable for a single-process demo.
 */

export interface RateLimitStore {
  hit(key: string, windowMs: number): number;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  hit(key: string, windowMs: number): number {
    const now = Date.now();
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return 1;
    }
    existing.count += 1;
    return existing.count;
  }

  clear(): void {
    this.buckets.clear();
  }
}

const defaultStore = new MemoryRateLimitStore();

export function rateLimit(options: {
  limit?: number;
  windowMs?: number;
  name?: string;
  store?: RateLimitStore;
}): RequestHandler {
  const limit = options.limit ?? 20;
  const windowMs = options.windowMs ?? 60 * 60 * 1000;
  const name = options.name ?? "auth";
  const store = options.store ?? defaultStore;

  return (req, _res, next) => {
    const ip =
      (typeof req.headers["x-forwarded-for"] === "string"
        ? req.headers["x-forwarded-for"].split(",")[0]?.trim()
        : undefined) ||
      req.socket.remoteAddress ||
      "unknown";
    const key = `${name}:${ip}`;
    const count = store.hit(key, windowMs);
    if (count > limit) {
      return next(
        new AppError(
          "TOO_MANY_REQUESTS",
          "Too many requests. Try again later.",
          429,
        ),
      );
    }
    next();
  };
}

export const sharedAuthRateLimitStore = defaultStore;
