import bcrypt from "bcrypt";

// bcrypt at cost 12 (SP-01.1). bcrypt only reads the first 72 bytes of a password, so longer
// passwords are refused instead of being silently truncated.
export const BCRYPT_COST = 12;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_BYTES = 72;

/** Problems with a password, as messages for a 422 response. Empty when the password is acceptable. */
export function passwordIssues(password: string): string[] {
  const issues: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) issues.push(`must be at least ${PASSWORD_MIN_LENGTH} characters`);
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) issues.push(`must be at most ${PASSWORD_MAX_BYTES} bytes`);
  return issues;
}

export async function hashPassword(password: string): Promise<string> {
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) {
    throw new Error(`password exceeds ${PASSWORD_MAX_BYTES} bytes`);
  }
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) return false;
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false; // a malformed stored hash never grants access
  }
}
