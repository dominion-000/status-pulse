import "dotenv/config";

/** Load and validate process configuration. Throws on missing required values. */

export interface Config {
  databaseUrl: string;
  credentialsEncKey: string;
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  workerLeaseSeconds: number;
  workerMaxAttempts: number;
  port: number;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return Math.floor(n);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL?.trim() || "";
  const credentialsEncKey = env.CREDENTIALS_ENC_KEY?.trim() || "";
  const jwtSecret = env.JWT_SECRET?.trim() || "";

  if (!env.STATUS_PULSE_SKIP_CONFIG_CHECK) {
    if (!databaseUrl) throw new Error("Missing required environment variable: DATABASE_URL");
    if (!credentialsEncKey) throw new Error("Missing required environment variable: CREDENTIALS_ENC_KEY");
    if (!jwtSecret || jwtSecret.length < 32) {
      throw new Error("JWT_SECRET must be set and at least 32 characters");
    }
  }

  return {
    databaseUrl,
    credentialsEncKey,
    jwtSecret: jwtSecret || "test-secret-at-least-32-characters!!",
    accessTokenTtlSeconds: intEnv("ACCESS_TOKEN_TTL_SECONDS", 900),
    refreshTokenTtlDays: intEnv("REFRESH_TOKEN_TTL_DAYS", 30),
    workerLeaseSeconds: intEnv("WORKER_LEASE_SECONDS", 60),
    workerMaxAttempts: intEnv("WORKER_MAX_ATTEMPTS", 5),
    port: intEnv("PORT", 3000),
  };
}
