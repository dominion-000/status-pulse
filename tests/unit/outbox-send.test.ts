import { describe, expect, it } from "vitest";
import { outboxBackoffSeconds } from "../../src/db/outbox";
import { createDefaultSender, MailSendError } from "../../src/dispatcher/send";

describe("outboxBackoffSeconds", () => {
  it("starts at 5 s and doubles", () => {
    expect(outboxBackoffSeconds(1)).toBe(5);
    expect(outboxBackoffSeconds(2)).toBe(10);
    expect(outboxBackoffSeconds(3)).toBe(20);
    expect(outboxBackoffSeconds(4)).toBe(40);
    expect(outboxBackoffSeconds(5)).toBe(80);
    expect(outboxBackoffSeconds(6)).toBe(160);
  });

  it("caps at 300 s", () => {
    expect(outboxBackoffSeconds(7)).toBe(300);
    expect(outboxBackoffSeconds(10)).toBe(300);
  });
});

describe("createDefaultSender", () => {
  it("succeeds for ordinary addresses", async () => {
    const send = createDefaultSender({ MAIL_FAIL_ALL: "0" });
    await expect(
      send({ to: "owner@example.com", subject: "s", body: "b" }),
    ).resolves.toBeUndefined();
  });

  it("fails addresses on fail.example", async () => {
    const send = createDefaultSender({ MAIL_FAIL_ALL: "0" });
    await expect(
      send({ to: "x@fail.example", subject: "s", body: "b" }),
    ).rejects.toBeInstanceOf(MailSendError);
  });

  it("fails every address when MAIL_FAIL_ALL=1", async () => {
    const send = createDefaultSender({ MAIL_FAIL_ALL: "1" });
    await expect(
      send({ to: "owner@example.com", subject: "s", body: "b" }),
    ).rejects.toBeInstanceOf(MailSendError);
  });
});
