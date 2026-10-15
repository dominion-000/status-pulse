import { createHash, randomBytes } from "node:crypto";

/** Generate a raw verification token and its SHA-256 hash for storage. */
export function createVerificationToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}
