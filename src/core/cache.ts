/**
 * Cache backed by Redis when REDIS_URL is set (shared across instances).
 * Falls back to in-process TTL map when Redis is unavailable (local/tests).
 */
import { createClient, type RedisClientType } from "redis";
import { log } from "./log";

type MemoryEntry = { value: string; expiresAt: number };

const memory = new Map<string, MemoryEntry>();

let redis: RedisClientType | null = null;
let redisReady: Promise<RedisClientType | null> | null = null;

async function getRedis(): Promise<RedisClientType | null> {
  const url = process.env.REDIS_URL?.trim();
  if (!url) return null;
  if (redis?.isOpen) return redis;
  if (redisReady) return redisReady;

  redisReady = (async () => {
    try {
      const client = createClient({ url });
      client.on("error", (err) => {
        log.warn("redis.error", { err: String(err) });
      });
      await client.connect();
      redis = client as RedisClientType;
      log.info("redis.connected");
      return redis;
    } catch (err) {
      log.warn("redis.connect_failed", { err: String(err) });
      redisReady = null;
      return null;
    }
  })();

  return redisReady;
}

function defaultTtlSec(): number {
  const ms = Number(process.env.PUBLIC_STATUS_CACHE_MS ?? 5000);
  return Math.max(1, Math.ceil((Number.isFinite(ms) ? ms : 5000) / 1000));
}

export async function cacheGet(key: string): Promise<string | null> {
  const client = await getRedis();
  if (client) {
    try {
      return await client.get(key);
    } catch (err) {
      log.warn("redis.get_failed", { key, err: String(err) });
    }
  }
  const e = memory.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    memory.delete(key);
    return null;
  }
  return e.value;
}

export async function cacheSet(
  key: string,
  value: string,
  ttlSec = defaultTtlSec(),
): Promise<void> {
  const client = await getRedis();
  if (client) {
    try {
      await client.set(key, value, { EX: ttlSec });
      return;
    } catch (err) {
      log.warn("redis.set_failed", { key, err: String(err) });
    }
  }
  memory.set(key, {
    value,
    expiresAt: Date.now() + ttlSec * 1000,
  });
}

export async function cacheDel(key: string): Promise<void> {
  const client = await getRedis();
  if (client) {
    try {
      await client.del(key);
    } catch (err) {
      log.warn("redis.del_failed", { key, err: String(err) });
    }
  }
  memory.delete(key);
}

export function publicStatusKey(slug: string): string {
  return `public:status:${slug}`;
}
