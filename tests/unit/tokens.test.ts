import { describe, expect, it } from "vitest";
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from "../../src/auth/tokens";

const SECRET = "test-secret-at-least-32-characters-long";

describe("access tokens", () => {
  it("round-trips a user id", () => {
    const token = signAccessToken("user-1", SECRET, 60);
    const payload = verifyAccessToken(token, SECRET);
    expect(payload.sub).toBe("user-1");
    expect(payload.typ).toBe("access");
  });

  it("rejects a token signed with the wrong secret", () => {
    const token = signAccessToken("user-1", SECRET, 60);
    expect(() => verifyAccessToken(token, "other-secret-at-least-32-chars!!!!")).toThrow();
  });
});

describe("refresh tokens", () => {
  it("stores only a hash of the raw token", () => {
    const { raw, hash } = generateRefreshToken();
    expect(hash).toBe(hashRefreshToken(raw));
    expect(hash).not.toBe(raw);
    expect(hash).toHaveLength(64);
  });
});
