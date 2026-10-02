import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";

export interface AccessPayload {
  sub: string; // user id
  typ: "access";
}

export function signAccessToken(
  userId: string,
  secret: string,
  ttlSeconds: number,
): string {
  const payload: AccessPayload = { sub: userId, typ: "access" };
  return jwt.sign(payload, secret, { expiresIn: ttlSeconds });
}

export function verifyAccessToken(token: string, secret: string): AccessPayload {
  const decoded = jwt.verify(token, secret) as AccessPayload;
  if (decoded.typ !== "access" || typeof decoded.sub !== "string") {
    throw new Error("invalid token type");
  }
  return decoded;
}

/** Opaque refresh token: random bytes, stored only as a hash. */
export function generateRefreshToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashRefreshToken(raw) };
}

export function hashRefreshToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
