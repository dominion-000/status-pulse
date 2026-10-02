import type { RequestHandler } from "express";
import { verifyAccessToken } from "../auth/tokens";
import { unauthorizedError } from "../errors";
import type { Config } from "../config";
import type { PrismaClient } from "../../prisma/generated";

export interface AuthUser {
  id: string;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      config?: Config;
      prisma?: PrismaClient;
    }
  }
}

export function requireAuth(config: Config): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return next(unauthorizedError());
    }
    const token = header.slice(7);
    try {
      const payload = verifyAccessToken(token, config.jwtSecret);
      req.user = { id: payload.sub, email: "" };
      next();
    } catch {
      next(unauthorizedError("Invalid or expired access token"));
    }
  };
}

/** Load the user's email after verifying the token (for audit / responses). */
export function loadUser(prisma: PrismaClient): RequestHandler {
  return async (req, _res, next) => {
    if (!req.user) return next(unauthorizedError());
    try {
      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
      if (!user) return next(unauthorizedError("User no longer exists"));
      req.user = { id: user.id, email: user.email };
      next();
    } catch (err) {
      next(err);
    }
  };
}
