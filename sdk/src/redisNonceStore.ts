/**
 * Redis-based NonceStore for production deployments.
 *
 * Survives server restarts and works across multiple instances.
 * Requires `ioredis` as a peer dependency.
 *
 * Usage:
 *   import Redis from "ioredis";
 *   import { RedisNonceStore } from "fhe-x402-sdk";
 *
 *   const redis = new Redis(process.env.REDIS_URL);
 *   const nonceStore = new RedisNonceStore(redis);
 *
 *   app.use("/api", fhePaywall({
 *     ...config,
 *     nonceStore,
 *   }));
 */
import type { NonceStore } from "./types.js";

export interface RedisNonceStoreOptions {
  /** Key prefix for nonce entries (default: "fhe-x402:nonce:") */
  prefix?: string;
  /** TTL in seconds for nonce entries (default: 86400 = 24h) */
  ttlSeconds?: number;
}

/**
 * Redis-based NonceStore implementation.
 * Uses SET NX EX for atomic check-and-add (no TOCTOU race).
 *
 * Accepts any Redis client with `set(key, value, "EX", ttl, "NX")` and `get(key)` methods.
 * Compatible with ioredis and node-redis.
 */
export class RedisNonceStore implements NonceStore {
  private redis: RedisLike;
  private prefix: string;
  private ttlSeconds: number;

  constructor(redis: RedisLike, options: RedisNonceStoreOptions = {}) {
    this.redis = redis;
    this.prefix = options.prefix ?? "fhe-x402:nonce:";
    this.ttlSeconds = options.ttlSeconds ?? 86400;
  }

  async check(nonce: string): Promise<boolean> {
    const result = await this.redis.get(this.prefix + nonce);
    return result === null;
  }

  async add(nonce: string): Promise<void> {
    await this.redis.set(this.prefix + nonce, "1", "EX", this.ttlSeconds);
  }

  /** Atomic check-and-add using SET NX EX. Returns true if nonce is new. */
  async checkAndAdd(nonce: string): Promise<boolean> {
    // SET key value EX ttl NX — only sets if key does NOT exist
    // Returns "OK" if set, null if key already existed
    const result = await this.redis.set(this.prefix + nonce, "1", "EX", this.ttlSeconds, "NX");
    return result === "OK";
  }
}

/** Minimal Redis client interface (compatible with ioredis and node-redis) */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<string | null>;
}
