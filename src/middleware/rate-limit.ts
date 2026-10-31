import type { RequestHandler } from "express";
import { AppError } from "../errors";

/**
 * In-memory rate limiter (single process).
 * Auth (login/register) and subscribe use separate stores.
 *
 * Defaults are intentionally generous for demos and UI-driven traffic.
 * Env: RATE_LIMIT_DISABLED=1|true|yes  AUTH_RATE_LIMIT  AUTH_RATE_WINDOW_MS
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

export const authRateLimitStore = new MemoryRateLimitStore();
export const subscribeRateLimitStore = new MemoryRateLimitStore();
/** @deprecated */
export const sharedAuthRateLimitStore = authRateLimitStore;

function rateLimitDisabled(): boolean {
  const v = (process.env.RATE_LIMIT_DISABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function rateLimit(options: {
  limit?: number;
  windowMs?: number;
  name?: string;
  store?: RateLimitStore;
}): RequestHandler {
  // Auth: 120 / 15 min. Subscribe: 30 / hour (still abuse-resistant).
  const defaultLimit =
    options.name === "subscribe"
      ? envInt("SUBSCRIBE_RATE_LIMIT", 30)
      : envInt("AUTH_RATE_LIMIT", 120);
  const defaultWindow =
    options.name === "subscribe"
      ? envInt("SUBSCRIBE_RATE_WINDOW_MS", 60 * 60 * 1000)
      : envInt("AUTH_RATE_WINDOW_MS", 15 * 60 * 1000);

  const limit = options.limit ?? defaultLimit;
  const windowMs = options.windowMs ?? defaultWindow;
  const name = options.name ?? "auth";
  const store = options.store ?? authRateLimitStore;

  return (req, _res, next) => {
    if (rateLimitDisabled()) {
      next();
      return;
    }

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
