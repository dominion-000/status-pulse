import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../../src/core/secrets";

const key = randomBytes(32).toString("base64");

describe("credential encryption (SP-02.6)", () => {
  it("round-trips, and the stored blob does not contain the plaintext", () => {
    const blob = encryptSecret("Bearer s3cret-token", key);
    expect(blob.toString("utf8")).not.toContain("s3cret-token");
    expect(decryptSecret(blob, key)).toBe("Bearer s3cret-token");
  });

  it("produces a different blob each time for the same input", () => {
    expect(encryptSecret("same", key).equals(encryptSecret("same", key))).toBe(false);
  });

  it("fails with the wrong key", () => {
    const blob = encryptSecret("x", key);
    expect(() => decryptSecret(blob, randomBytes(32).toString("base64"))).toThrow();
  });

  it("fails when the stored data has been modified", () => {
    const blob = encryptSecret("x", key);
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 1;
    expect(() => decryptSecret(blob, key)).toThrow();
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => encryptSecret("x", "short")).toThrow(/32 bytes/);
  });
});
