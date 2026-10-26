import type { PrismaClient } from "../../prisma/generated";
import { hashPassword, passwordIssues } from "../core/password";

export type RegisterUserResult =
  | {
      ok: true;
      user: { id: string; email: string; name: string | null };
    }
  | {
      ok: false;
      reason: "email_taken" | "invalid_password";
      passwordMessages?: string[];
    };

/**
 * Create a user account. Password is hashed at cost 12.
 * Callers issue tokens (access / refresh) after a successful result.
 */
export async function registerUser(
  prisma: PrismaClient,
  input: {
    email: string;
    password: string;
    name?: string | null;
    /** When true, apply the same password rules as the API (passwordIssues). */
    strictPassword?: boolean;
  },
): Promise<RegisterUserResult> {
  const email = input.email.trim().toLowerCase();
  if (input.strictPassword !== false) {
    const issues = passwordIssues(input.password);
    if (issues.length) {
      return {
        ok: false,
        reason: "invalid_password",
        passwordMessages: issues,
      };
    }
  } else if (input.password.length < 8) {
    return {
      ok: false,
      reason: "invalid_password",
      passwordMessages: ["Password must be at least 8 characters"],
    };
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return { ok: false, reason: "email_taken" };

  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name: input.name ?? null,
    },
  });
  return {
    ok: true,
    user: { id: user.id, email: user.email, name: user.name },
  };
}
