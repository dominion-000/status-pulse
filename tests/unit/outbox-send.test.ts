import { describe, expect, it } from "vitest";
import { createDefaultSender } from "../../src/dispatcher/send";

describe("createDefaultSender", () => {
  it("uses the in-process test sender under NODE_ENV=test", async () => {
    const send = createDefaultSender({ NODE_ENV: "test" });
    await expect(
      send({ to: "owner@example.com", subject: "s", body: "b" }),
    ).resolves.toBeUndefined();
  });

  it("fails closed without BREVO_API_KEY outside test", async () => {
    const send = createDefaultSender({
      NODE_ENV: "production",
      BREVO_API_KEY: "",
      MAIL_FROM: "Status Pulse <ops@example.com>",
    });
    await expect(
      send({ to: "owner@example.com", subject: "s", body: "b" }),
    ).rejects.toThrow(/BREVO_API_KEY/);
  });

  it("fails closed without MAIL_FROM outside test", async () => {
    const send = createDefaultSender({
      NODE_ENV: "production",
      BREVO_API_KEY: "key",
      MAIL_FROM: "",
    });
    await expect(
      send({ to: "owner@example.com", subject: "s", body: "b" }),
    ).rejects.toThrow(/MAIL_FROM/);
  });

  it("sends via Brevo when BREVO_API_KEY and MAIL_FROM are set", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 201, text: async () => "" } as Response;
    }) as typeof fetch;
    try {
      const send = createDefaultSender({
        NODE_ENV: "production",
        BREVO_API_KEY: "xbkey",
        MAIL_FROM: "StatusGrep <alerts@example.com>",
      });
      await send({ to: "owner@example.com", subject: "Hello", body: "World" });
      expect(calls[0]?.url).toContain("api.brevo.com");
      const body = JSON.parse(String(calls[0]?.init?.body ?? "{}"));
      expect(body.sender.email).toBe("alerts@example.com");
      expect(body.to[0].email).toBe("owner@example.com");
      expect(body.subject).toBe("Hello");
      expect(body.textContent).toBe("World");
    } finally {
      globalThis.fetch = original;
    }
  });
});
