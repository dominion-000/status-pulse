import { createHash, randomBytes } from "node:crypto";

/** Generate a raw verification token and its SHA-256 hash for storage. */
export function createVerificationToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Whether the subscribe response may carry the raw verification token. The token proves the subscriber controls the
 * address, so returning it to the caller defeats the check: it is therefore off in production. Locally and in tests
 * it is on so the flow can be shown without a mailbox; EXPOSE_VERIFICATION_TOKEN=1 or 0 overrides either way.
 */
export function exposeVerificationToken(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flag = (env.EXPOSE_VERIFICATION_TOKEN ?? "").toLowerCase();
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return env.NODE_ENV !== "production";
}
