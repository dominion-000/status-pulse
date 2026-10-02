import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "../../prisma/generated";
import type { Config } from "../config";
import { hashPassword, passwordIssues, verifyPassword } from "../core/password";
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from "../auth/tokens";
import { conflictError, unauthorizedError, validationError } from "../errors";
import { validateBody } from "../middleware/validate";

const registerSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

function tokenPair(
  userId: string,
  config: Config,
  rawRefresh: string,
): { accessToken: string; refreshToken: string; expiresIn: number } {
  return {
    accessToken: signAccessToken(userId, config.jwtSecret, config.accessTokenTtlSeconds),
    refreshToken: rawRefresh,
    expiresIn: config.accessTokenTtlSeconds,
  };
}

export function authRoutes(prisma: PrismaClient, config: Config): Router {
  const r = Router();

  r.post("/register", validateBody(registerSchema), async (req, res, next) => {
    try {
      const { email, password, name } = req.body as z.infer<typeof registerSchema>;
      const issues = passwordIssues(password);
      if (issues.length) {
        return next(validationError("Invalid password", issues.map((m) => ({ path: "password", message: m }))));
      }

      const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
      if (existing) return next(conflictError("Email already registered"));

      const passwordHash = await hashPassword(password);
      const user = await prisma.user.create({
        data: {
          email: email.toLowerCase(),
          passwordHash,
          name: name ?? null,
        },
      });

      const { raw, hash } = generateRefreshToken();
      const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 86400_000);
      await prisma.refreshToken.create({
        data: { userId: user.id, tokenHash: hash, expiresAt },
      });

      res.status(201).json({
        user: { id: user.id, email: user.email, name: user.name },
        ...tokenPair(user.id, config, raw),
      });
    } catch (err) {
      next(err);
    }
  });

  r.post("/login", validateBody(loginSchema), async (req, res, next) => {
    try {
      const { email, password } = req.body as z.infer<typeof loginSchema>;
      const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        return next(unauthorizedError("Invalid email or password"));
      }

      const { raw, hash } = generateRefreshToken();
      const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 86400_000);
      await prisma.refreshToken.create({
        data: { userId: user.id, tokenHash: hash, expiresAt },
      });

      res.json({
        user: { id: user.id, email: user.email, name: user.name },
        ...tokenPair(user.id, config, raw),
      });
    } catch (err) {
      next(err);
    }
  });

  r.post("/refresh", validateBody(refreshSchema), async (req, res, next) => {
    try {
      const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
      const tokenHash = hashRefreshToken(refreshToken);
      const stored = await prisma.refreshToken.findFirst({
        where: { tokenHash },
      });

      if (!stored) return next(unauthorizedError("Invalid refresh token"));

      // Already used or revoked → revoke all sessions for this user (reuse detection)
      if (stored.revokedAt) {
        await prisma.refreshToken.updateMany({
          where: { userId: stored.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return next(unauthorizedError("Refresh token already used"));
      }

      if (stored.expiresAt.getTime() < Date.now()) {
        await prisma.refreshToken.update({
          where: { id: stored.id },
          data: { revokedAt: new Date() },
        });
        return next(unauthorizedError("Refresh token expired"));
      }

      // Rotate: revoke old, issue new
      const { raw, hash } = generateRefreshToken();
      const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 86400_000);
      await prisma.$transaction([
        prisma.refreshToken.update({
          where: { id: stored.id },
          data: { revokedAt: new Date() },
        }),
        prisma.refreshToken.create({
          data: { userId: stored.userId, tokenHash: hash, expiresAt },
        }),
      ]);

      res.json(tokenPair(stored.userId, config, raw));
    } catch (err) {
      next(err);
    }
  });

  return r;
}
