import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "../../prisma/generated";
import type { Config } from "../config";
import {
  hashPassword,
  passwordIssues,
  verifyPassword,
} from "../core/password";
import { registerUser } from "../db/register-user";
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from "../auth/tokens";
import {
  conflictError,
  unauthorizedError,
  validationError,
} from "../errors";
import { requireAuth, loadUser } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import { rateLimit, authRateLimitStore } from "../middleware/rate-limit";

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
    accessToken: signAccessToken(
      userId,
      config.jwtSecret,
      config.accessTokenTtlSeconds,
    ),
    refreshToken: rawRefresh,
    expiresIn: config.accessTokenTtlSeconds,
  };
}

export function authRoutes(prisma: PrismaClient, config: Config): Router {
  const r = Router();

  r.post(
    "/register",
    rateLimit({ name: "auth", store: authRateLimitStore }),
    validateBody(registerSchema),
    async (req, res, next) => {
      try {
        const { email, password, name } = req.body as z.infer<
          typeof registerSchema
        >;
        const created = await registerUser(prisma, {
          email,
          password,
          name: name ?? null,
          strictPassword: true,
        });
        if (!created.ok) {
          if (created.reason === "invalid_password") {
            return next(
              validationError(
                "Invalid password",
                (created.passwordMessages ?? []).map((m) => ({
                  path: "password",
                  message: m,
                })),
              ),
            );
          }
          return next(conflictError("Email already registered"));
        }
        const user = created.user;

        await prisma.outboxMessage.create({
          data: {
            kind: "account_welcome",
            recipientEmail: user.email,
            subject: "Welcome to StatusGrep",
            body: [
              "Hello" + (user.name ? `, ${user.name}` : "") + ",",
              "",
              "Your StatusGrep account is ready. Sign in to create a project and start monitoring endpoints.",
              "",
              "— StatusGrep",
            ].join("\n"),
          },
        });

        const { raw, hash } = generateRefreshToken();
        const expiresAt = new Date(
          Date.now() + config.refreshTokenTtlDays * 86400_000,
        );
        await prisma.refreshToken.create({
          data: { userId: user.id, tokenHash: hash, expiresAt },
        });

        res.status(201).json({
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            isAdmin: user.isAdmin,
          },
          ...tokenPair(user.id, config, raw),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  r.post(
    "/login",
    rateLimit({ name: "auth", store: authRateLimitStore }),
    validateBody(loginSchema),
    async (req, res, next) => {
      try {
        const { email, password } = req.body as z.infer<typeof loginSchema>;
        const user = await prisma.user.findUnique({
          where: { email: email.toLowerCase() },
        });
        if (!user || !(await verifyPassword(password, user.passwordHash))) {
          return next(unauthorizedError("Invalid email or password"));
        }

        const { raw, hash } = generateRefreshToken();
        const expiresAt = new Date(
          Date.now() + config.refreshTokenTtlDays * 86400_000,
        );
        await prisma.refreshToken.create({
          data: { userId: user.id, tokenHash: hash, expiresAt },
        });

        res.json({
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            isAdmin: user.isAdmin,
          },
          ...tokenPair(user.id, config, raw),
        });
      } catch (err) {
        next(err);
      }
    },
  );

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
      const expiresAt = new Date(
        Date.now() + config.refreshTokenTtlDays * 86400_000,
      );
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



  r.post(
    "/forgot-password",
    rateLimit({ name: "auth", store: authRateLimitStore }),
    validateBody(z.object({ email: z.string().email() })),
    async (req, res, next) => {
      try {
        const email = (req.body as { email: string }).email.trim().toLowerCase();
        const user = await prisma.user.findUnique({ where: { email } });
        if (user) {
          const raw = randomBytes(32).toString("hex");
          const tokenHash = createHash("sha256").update(raw).digest("hex");
          await prisma.user.update({
            where: { id: user.id },
            data: {
              passwordResetTokenHash: tokenHash,
              passwordResetExpiresAt: new Date(Date.now() + 3600_000),
            },
          });
          const appUrl = (process.env.PUBLIC_APP_URL || process.env.STATUSGREP_URL || "")
            .trim()
            .replace(/\/$/, "");
          const resetLink = appUrl
            ? `${appUrl}/reset-password?token=${encodeURIComponent(raw)}`
            : "";
          await prisma.outboxMessage.create({
            data: {
              kind: "password_reset",
              recipientEmail: user.email,
              subject: "Reset your StatusGrep password",
              body: [
                `Hello${user.name ? ` ${user.name}` : ""},`,
                "",
                "You requested a password reset. This link expires in one hour.",
                resetLink || "Open StatusGrep → Reset password and paste this token:",
                resetLink || raw,
                "",
                "If the link does not work, use this token on the Reset password page:",
                raw,
                "",
                "If you did not request this, ignore this message.",
                "",
                "— StatusGrep",
              ].join("\n"),
            },
          });
        }
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  r.post(
    "/reset-password",
    rateLimit({ name: "auth", store: authRateLimitStore }),
    validateBody(
      z.object({ token: z.string().min(1), password: z.string().min(1) }),
    ),
    async (req, res, next) => {
      try {
        const { token, password } = req.body as {
          token: string;
          password: string;
        };
        const issues = passwordIssues(password);
        if (issues.length) {
          return next(
            validationError(
              "Invalid password",
              issues.map((m) => ({ path: "password", message: m })),
            ),
          );
        }
        const tokenHash = createHash("sha256").update(token).digest("hex");
        const user = await prisma.user.findFirst({
          where: {
            passwordResetTokenHash: tokenHash,
            passwordResetExpiresAt: { gt: new Date() },
          },
        });
        if (!user) {
          return next(unauthorizedError("Invalid or expired reset token"));
        }
        await prisma.user.update({
          where: { id: user.id },
          data: {
            passwordHash: await hashPassword(password),
            passwordResetTokenHash: null,
            passwordResetExpiresAt: null,
          },
        });
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );


  const meAuth = [requireAuth(config), loadUser(prisma)] as const;

  r.get("/me", ...meAuth, async (req, res, next) => {
    try {
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: req.user!.id },
      });
      res.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          isAdmin: user.isAdmin,
          createdAt: user.createdAt.toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  const patchMeSchema = z
    .object({
      name: z.string().trim().min(1).max(120).nullable().optional(),
      email: z.string().email().max(320).optional(),
      currentPassword: z.string().min(1).optional(),
      newPassword: z.string().min(1).optional(),
    })
    .refine(
      (b) =>
        b.name !== undefined ||
        b.email !== undefined ||
        b.newPassword !== undefined,
      { message: "Provide name, email, and/or newPassword" },
    )
    .refine(
      (b) => !b.newPassword || Boolean(b.currentPassword),
      { message: "currentPassword is required to set a new password", path: ["currentPassword"] },
    );

  r.patch("/me", ...meAuth, validateBody(patchMeSchema), async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof patchMeSchema>;
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: req.user!.id },
      });

      if (body.newPassword) {
        const ok = await verifyPassword(
          body.currentPassword!,
          user.passwordHash,
        );
        if (!ok) {
          return next(unauthorizedError("Current password is incorrect"));
        }
        const issues = passwordIssues(body.newPassword);
        if (issues.length) {
          return next(
            validationError(
              "Invalid password",
              issues.map((m) => ({ path: "newPassword", message: m })),
            ),
          );
        }
      }

      if (body.email && body.email.toLowerCase() !== user.email.toLowerCase()) {
        const taken = await prisma.user.findUnique({
          where: { email: body.email.toLowerCase() },
        });
        if (taken) return next(conflictError("Email already registered"));
      }

      const data: {
        name?: string | null;
        email?: string;
        passwordHash?: string;
      } = {};
      if (body.name !== undefined) data.name = body.name;
      if (body.email) data.email = body.email.toLowerCase();
      if (body.newPassword) data.passwordHash = await hashPassword(body.newPassword);

      const updated = await prisma.user.update({
        where: { id: user.id },
        data,
      });

      res.json({
        user: {
          id: updated.id,
          email: updated.email,
          name: updated.name,
          isAdmin: updated.isAdmin,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
