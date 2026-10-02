import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { URL } from "node:url";
import { isForbiddenIp } from "../core/url-safety";

export interface CheckInput {
  url: string;
  method: string;
  timeoutSeconds: number;
  expectedStatusCodes: number[];
  expectedBodyText: string | null;
  /** Optional Authorization header value (already decrypted). */
  authorization?: string | undefined;
}

export interface CheckOutcome {
  statusCode: number | null;
  latencyMs: number | null;
  passed: boolean;
  failureReason: string | null;
}

/**
 * Resolve host, reject private addresses, connect without following redirects,
 * enforce a hard timeout. Used by the worker (SP-02.3, SP-03.5).
 */
export async function runHttpCheck(input: CheckInput): Promise<CheckOutcome> {
  const started = Date.now();
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return { statusCode: null, latencyMs: null, passed: false, failureReason: "invalid_url" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { statusCode: null, latencyMs: null, passed: false, failureReason: "unsupported_scheme" };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let address: string;
  try {
    if (isIP(hostname)) {
      address = hostname;
    } else {
      const records = await lookup(hostname, { all: true });
      const first = records[0];
      if (!first) {
        return { statusCode: null, latencyMs: Date.now() - started, passed: false, failureReason: "dns_failed" };
      }
      address = first.address;
    }
  } catch {
    return { statusCode: null, latencyMs: Date.now() - started, passed: false, failureReason: "dns_failed" };
  }

  if (isForbiddenIp(address)) {
    return { statusCode: null, latencyMs: Date.now() - started, passed: false, failureReason: "forbidden_address" };
  }

  const isHttps = url.protocol === "https:";
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
  const path = `${url.pathname}${url.search}`;

  return new Promise((resolve) => {
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const req = reqFn(
      {
        hostname: address,
        servername: hostname, // SNI / Host
        port,
        path,
        method: input.method,
        headers: {
          Host: url.host,
          "User-Agent": "StatusPulse/0.1",
          Accept: "*/*",
          ...(input.authorization ? { Authorization: input.authorization } : {}),
        },
        timeout: input.timeoutSeconds * 1000,
        // Do not follow redirects
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => {
          if (Buffer.concat(chunks).length < 64_000) chunks.push(c);
        });
        res.on("end", () => {
          const latencyMs = Date.now() - started;
          const statusCode = res.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString("utf8");

          if (!input.expectedStatusCodes.includes(statusCode)) {
            resolve({
              statusCode,
              latencyMs,
              passed: false,
              failureReason: `unexpected_status:${statusCode}`,
            });
            return;
          }
          if (input.expectedBodyText && !body.includes(input.expectedBodyText)) {
            resolve({
              statusCode,
              latencyMs,
              passed: false,
              failureReason: "body_mismatch",
            });
            return;
          }
          resolve({ statusCode, latencyMs, passed: true, failureReason: null });
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      resolve({
        statusCode: null,
        latencyMs: Date.now() - started,
        passed: false,
        failureReason: "timeout",
      });
    });
    req.on("error", (err) => {
      resolve({
        statusCode: null,
        latencyMs: Date.now() - started,
        passed: false,
        failureReason: `network:${err.message}`,
      });
    });
    req.end();
  });
}
