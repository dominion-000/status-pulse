import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";

describe("request logging", () => {
  it("logs the path but never the query string", async () => {
    const lines: string[] = [];
    const app = createApp({ logStream: { write: (l) => lines.push(l) } });

    await request(app).get("/health?token=super-secret-token");

    const log = lines.join("");
    expect(log).toContain("/health");
    expect(log).not.toContain("super-secret-token");
  });

  it("does not log request bodies or authorization headers", async () => {
    const lines: string[] = [];
    const app = createApp({ logStream: { write: (l) => lines.push(l) } });

    await request(app)
      .post("/nope")
      .set("Authorization", "Bearer secret-jwt")
      .send({ password: "hunter2-hunter2" });

    const log = lines.join("");
    expect(log).not.toContain("secret-jwt");
    expect(log).not.toContain("hunter2");
  });
});

describe("error envelope", () => {
  it("returns the structured envelope for unknown routes", async () => {
    const res = await request(
      createApp({ logStream: { write: () => {} } }),
    ).get("/missing");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
