/**
 * Redis-backed NonceStore for fhe-x402 paywall middleware.
 *
 * Provides persistent, atomic nonce tracking that survives server restarts.
 * Uses Redis SET NX EX for atomic check-and-add with automatic TTL expiry.
 *
 * Install: npm install ioredis
 *
 * Usage:
 *   import { RedisNonceStore } from "./redis-nonce-store";
 *   import { fhePaywall } from "fhe-x402/sdk";
 *
 *   const nonceStore = new RedisNonceStore("redis://localhost:6379");
 *   app.use("/api/premium", fhePaywall({
 *     price: "1000000",
 *     asset: "USDC",
 *     poolAddress: "0x...",
 *     recipientAddress: "0x...",
 *     rpcUrl: "https://sepolia.infura.io/v3/...",
 *     nonceStore,
 *   }));
 */

import type { NonceStore } from "../sdk/src/types.js";
import Redis from "ioredis";

const KEY_PREFIX = "fhe:nonce:";
const TTL_SECONDS = 86_400; // 24 hours

export class RedisNonceStore implements NonceStore {
  private redis: Redis;

  constructor(redisUrl: string = "redis://localhost:6379") {
    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
  }

  /** Check if nonce is NEW (not seen before). */
  async check(nonce: string): Promise<boolean> {
    const exists = await this.redis.exists(`${KEY_PREFIX}${nonce}`);
    return exists === 0; // true if nonce is new
  }

  /** Mark nonce as used (with TTL). */
  async add(nonce: string): Promise<void> {
    await this.redis.set(`${KEY_PREFIX}${nonce}`, "1", "EX", TTL_SECONDS);
  }

  /**
   * Atomic check-and-add using SET NX EX.
   * Returns true if nonce is new (was set), false if replay (already existed).
   */
  async checkAndAdd(nonce: string): Promise<boolean> {
    const result = await this.redis.set(
      `${KEY_PREFIX}${nonce}`,
      "1",
      "EX",
      TTL_SECONDS,
      "NX",
    );
    return result === "OK"; // "OK" if key was set (nonce is new), null if existed
  }

  /** Gracefully close the Redis connection. */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}
