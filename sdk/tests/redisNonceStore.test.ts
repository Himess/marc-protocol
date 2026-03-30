import { describe, it, expect, vi, beforeEach } from "vitest";
import { RedisNonceStore } from "../src/redisNonceStore.js";
import type { RedisLike } from "../src/redisNonceStore.js";

function createMockRedis(): RedisLike & { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
  };
}

describe("RedisNonceStore", () => {
  let redis: ReturnType<typeof createMockRedis>;
  let store: RedisNonceStore;

  beforeEach(() => {
    redis = createMockRedis();
    store = new RedisNonceStore(redis);
  });

  describe("checkAndAdd()", () => {
    it("returns true for new nonce (SET NX succeeds)", async () => {
      redis.set.mockResolvedValue("OK");
      expect(await store.checkAndAdd("nonce-3")).toBe(true);
      expect(redis.set).toHaveBeenCalledWith("fhe-x402:nonce:nonce-3", "1", "EX", 86400, "NX");
    });

    it("returns false for existing nonce (SET NX fails)", async () => {
      redis.set.mockResolvedValue(null);
      expect(await store.checkAndAdd("nonce-3")).toBe(false);
    });

    it("is atomic — single Redis SET NX EX call", async () => {
      redis.set.mockResolvedValue("OK");
      await store.checkAndAdd("nonce-atomic");
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledWith("fhe-x402:nonce:nonce-atomic", "1", "EX", 86400, "NX");
      // No separate GET call (no TOCTOU)
      expect(redis.get).not.toHaveBeenCalled();
    });
  });

  describe("custom options", () => {
    it("uses custom prefix", async () => {
      const customStore = new RedisNonceStore(redis, { prefix: "myapp:" });
      await customStore.checkAndAdd("n1");
      expect(redis.set).toHaveBeenCalledWith("myapp:n1", "1", "EX", 86400, "NX");
    });

    it("uses custom TTL", async () => {
      const customStore = new RedisNonceStore(redis, { ttlSeconds: 3600 });
      await customStore.checkAndAdd("n2");
      expect(redis.set).toHaveBeenCalledWith("fhe-x402:nonce:n2", "1", "EX", 3600, "NX");
    });
  });

  describe("NonceStore interface compliance", () => {
    it("implements checkAndAdd (atomic, no separate check/add)", () => {
      expect(typeof store.checkAndAdd).toBe("function");
    });
  });
});
