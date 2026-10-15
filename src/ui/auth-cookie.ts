import type { Request, Response } from "express";
import { verifyAccessToken } from "../auth/tokens";
import type { Config } from "../config";

export const TOKEN_COOKIE = "sp_token";

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function setTokenCookie(res: Response, token: string, maxAgeSec: number): void {
  const parts = [
    `${TOKEN_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearTokenCookie(res: Response): void {
  res.setHeader(
    "Set-Cookie",
    `${TOKEN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

export function readUserId(req: Request, config: Config): string | null {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[TOKEN_COOKIE];
  if (!raw) return null;
  try {
    return verifyAccessToken(raw, config.jwtSecret).sub;
  } catch {
    return null;
  }
}
