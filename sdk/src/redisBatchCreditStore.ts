/**
 * Redis-based Batch Credit Store for production deployments.
 *
 * Replaces the in-memory batch credit store with Redis for persistence
 * and multi-instance support.
 *
 * Usage:
 *   import Redis from "ioredis";
 *   import { RedisBatchCreditStore } from "fhe-x402-sdk";
 *
 *   const redis = new Redis(process.env.REDIS_URL);
 *   const batchStore = new RedisBatchCreditStore(redis);
 */
import type { RedisLike } from "./redisNonceStore.js";

export interface BatchCreditStoreOptions {
  /** Key prefix (default: "fhe-x402:batch:") */
  prefix?: string;
  /** TTL in seconds (default: 604800 = 7 days) */
  ttlSeconds?: number;
}

export interface BatchCreditEntry {
  remaining: number;
  pricePerRequest: string;
  payer: string;
  server: string;
}

/**
 * Pluggable batch credit store interface.
 * Implement this for Redis, database, or other persistent storage.
 */
export interface BatchCreditStore {
  /** Get remaining credits. Returns 0 if not found. */
  get(payer: string, nonce: string): Promise<number>;
  /** Consume one credit. Returns true if credit consumed, false if none left. */
  consume(payer: string, nonce: string): Promise<boolean>;
  /** Register new batch credits. */
  register(payer: string, server: string, nonce: string, requestCount: number, pricePerRequest: string): Promise<void>;
}

export class RedisBatchCreditStore implements BatchCreditStore {
  private redis: RedisLike;
  private prefix: string;
  private ttlSeconds: number;

  constructor(redis: RedisLike, options: BatchCreditStoreOptions = {}) {
    this.redis = redis;
    this.prefix = options.prefix ?? "fhe-x402:batch:";
    this.ttlSeconds = options.ttlSeconds ?? 604800; // 7 days
  }

  private key(payer: string, nonce: string): string {
    return `${this.prefix}${payer.toLowerCase()}:${nonce}`;
  }

  async get(payer: string, nonce: string): Promise<number> {
    const data = await this.redis.get(this.key(payer, nonce));
    if (!data) return 0;
    try {
      const parsed = JSON.parse(data) as BatchCreditEntry;
      return parsed.remaining;
    } catch {
      return 0;
    }
  }

  async consume(payer: string, nonce: string): Promise<boolean> {
    const k = this.key(payer, nonce);
    const data = await this.redis.get(k);
    if (!data) return false;
    try {
      const parsed = JSON.parse(data) as BatchCreditEntry;
      if (parsed.remaining <= 0) return false;
      parsed.remaining--;
      if (parsed.remaining === 0) {
        // Delete the key when credits exhausted
        await this.redis.set(k, JSON.stringify(parsed), "EX", 1);
      } else {
        await this.redis.set(k, JSON.stringify(parsed), "EX", this.ttlSeconds);
      }
      return true;
    } catch {
      return false;
    }
  }

  async register(
    payer: string,
    server: string,
    nonce: string,
    requestCount: number,
    pricePerRequest: string
  ): Promise<void> {
    const k = this.key(payer, nonce);
    // NX — don't overwrite existing credits
    const existing = await this.redis.get(k);
    if (existing) return;

    const entry: BatchCreditEntry = {
      remaining: requestCount,
      pricePerRequest,
      payer: payer.toLowerCase(),
      server: server.toLowerCase(),
    };
    await this.redis.set(k, JSON.stringify(entry), "EX", this.ttlSeconds);
  }
}
