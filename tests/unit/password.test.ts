import { describe, expect, it } from "vitest";
import { hashPassword, passwordIssues, verifyPassword } from "../../src/core/password";

describe("password hashing (SP-01.1)", () => {
  it("uses bcrypt at cost 12 with a fresh salt each time", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).toMatch(/^\$2[aby]\$12\$/);
    expect(a).not.toBe(b);
  });

  it("verifies the right password and refuses a wrong one", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batterz", hash)).toBe(false);
  });

  it("never grants access against a malformed stored hash", async () => {
    expect(await verifyPassword("anything at all", "not-a-hash")).toBe(false);
    expect(await verifyPassword("anything at all", "")).toBe(false);
  });

  it("refuses to hash a password longer than 72 bytes instead of truncating it", async () => {
    await expect(hashPassword("a".repeat(73))).rejects.toThrow(/72 bytes/);
    expect(await verifyPassword("a".repeat(73), await hashPassword("a".repeat(72)))).toBe(false);
  });
});

describe("passwordIssues", () => {
  it("accepts a password within the limits", () => {
    expect(passwordIssues("correct horse battery")).toEqual([]);
  });

  it("rejects short passwords", () => {
    expect(passwordIssues("short")).toEqual(["must be at least 12 characters"]);
  });

  it("counts bytes, not characters, for the upper limit", () => {
    const manyAccents = "é".repeat(40); // 40 characters, 80 bytes
    expect(passwordIssues(manyAccents)).toEqual(["must be at most 72 bytes"]);
    expect(passwordIssues("é".repeat(36))).toEqual([]); // 72 bytes exactly
  });
});
