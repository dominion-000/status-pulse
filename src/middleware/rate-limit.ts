import type { RequestHandler } from "express";
import { AppError } from "../errors";

/**
 * In-memory rate limiter (single process).
 * Auth (login/register) and subscribe use separate stores so rehearsing
 * one flow does not lock out the other.
 */

export interface RateLimitStore {
  hit(key: string, windowMs: number): number;
  clear(): void;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<
    string,
    { count: number; resetAt: number }
  >();

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

/** Login + register only. */
export const authRateLimitStore = new MemoryRateLimitStore();

/** Public subscribe only. */
export const subscribeRateLimitStore = new MemoryRateLimitStore();

/** @deprecated use authRateLimitStore */
export const sharedAuthRateLimitStore = authRateLimitStore;

export function rateLimit(options: {
  limit?: number;
  windowMs?: number;
  name?: string;
  store?: RateLimitStore;
}): RequestHandler {
  const limit = options.limit ?? 20;
  const windowMs = options.windowMs ?? 60 * 60 * 1000;
  const name = options.name ?? "auth";
  const store = options.store ?? authRateLimitStore;

  return (req, _res, next) => {
    if (process.env.RATE_LIMIT_DISABLED === "1") {
      next();
      return;
    }

    // Never the X-Forwarded-For header: the client writes it, so keying on it lets anyone dodge the limit.
    // Behind a proxy set TRUST_PROXY_HOPS (see app.ts) and req.ip is the real client.
    const ip = req.ip || req.socket.remoteAddress || "unknown";

    const key = `${name}:${ip}`;
    const count = store.hit(key, windowMs);
    if (count > limit) {
      next(
        new AppError(
          "TOO_MANY_REQUESTS",
          "Too many requests; try again later",
          429,
        ),
      );
      return;
    }
    next();
  };
}
