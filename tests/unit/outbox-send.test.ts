import { describe, expect, it } from "vitest";
import { outboxBackoffSeconds } from "../../src/db/outbox";
import { createDefaultSender, MailSendError } from "../../src/dispatcher/send";

describe("outboxBackoffSeconds", () => {
  it("starts at 5 s and doubles", () => {
    expect(outboxBackoffSeconds(1)).toBe(5);
    expect(outboxBackoffSeconds(2)).toBe(10);
    expect(outboxBackoffSeconds(6)).toBe(160);
  });

  it("caps at 300 s", () => {
    expect(outboxBackoffSeconds(7)).toBe(300);
  });
});

describe("createDefaultSender", () => {
  it("in test env succeeds without Resend", async () => {
    const send = createDefaultSender({ NODE_ENV: "test" });
    await expect(
      send({ to: "owner@example.com", subject: "s", body: "b" }),
    ).resolves.toBeUndefined();
  });

  it("fails addresses on fail.example", async () => {
    const send = createDefaultSender({ NODE_ENV: "test" });
    await expect(
      send({ to: "x@fail.example", subject: "s", body: "b" }),
    ).rejects.toBeInstanceOf(MailSendError);
  });

  it("fails closed without RESEND_API_KEY outside test", async () => {
    const send = createDefaultSender({ NODE_ENV: "production" });
    await expect(
      send({ to: "owner@example.com", subject: "s", body: "b" }),
    ).rejects.toThrow(/RESEND_API_KEY/);
  });

  it("sends via Resend when RESEND_API_KEY is set", async () => {
    const calls: { url: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      calls.push({ url: String(url) });
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as typeof fetch;
    try {
      const send = createDefaultSender({
        NODE_ENV: "production",
        RESEND_API_KEY: "re_test",
        MAIL_FROM: "Status Pulse <alerts@example.com>",
      });
      await send({ to: "owner@example.com", subject: "Hello", body: "World" });
      expect(calls[0]?.url).toContain("api.resend.com");
    } finally {
      globalThis.fetch = original;
    }
  });
});
