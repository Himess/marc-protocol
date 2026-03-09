import crypto from "crypto";
import { POOL_ABI } from "./types.js";

export interface BalanceGatewayConfig {
  poolAddress: string;
  rpcUrl: string;
  /** Private key of the gateway operator (needs gas for requestBalance TX) */
  signerPrivateKey: string;
  /** API key for authentication (optional but recommended) */
  apiKey?: string;
  /** Max requests per IP per window (default: 10) */
  maxRateLimit?: number;
  /** Rate limit window in ms (default: 60000 = 1 min) */
  rateLimitWindowMs?: number;
}

/** Constant-time string comparison to prevent timing attacks */
function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Create a Balance Gateway Express app.
 *
 * Provides server-side endpoints for requesting and reading decrypted balances,
 * since fhevmjs in the browser only supports encryption, not decryption.
 *
 * Endpoints:
 *   POST /api/balance-request — triggers requestBalance() on-chain
 *   GET  /api/balance/:address — returns decrypted balance or "pending"
 *   GET  /health
 *
 * Usage:
 *   const app = await createBalanceGateway({
 *     poolAddress: '0x...',
 *     rpcUrl: 'https://sepolia.infura.io/v3/...',
 *     signerPrivateKey: '0x...',
 *     apiKey: 'secret-key',
 *   });
 *   app.listen(3002);
 */
export async function createBalanceGateway(config: BalanceGatewayConfig): Promise<any> {
  const expressModule = await import("express");
  const express = expressModule.default ?? expressModule;
  const app = express();
  app.use(express.json({ limit: "100kb" }));

  // Rate limiting state
  const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
  const maxRate = config.maxRateLimit ?? 10;
  const windowMs = config.rateLimitWindowMs ?? 60_000;

  function checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= maxRate) return false;
    entry.count++;
    return true;
  }

  // API key auth middleware
  if (config.apiKey) {
    app.use((req: any, res: any, nextFn: any) => {
      if (req.path === "/health") return nextFn();
      const key =
        req.headers["x-fhe-x402-api-key"] ||
        req.headers["authorization"]?.replace("Bearer ", "");
      if (!key || !timingSafeCompare(key, config.apiKey!)) {
        return res.status(401).json({ error: "Unauthorized: invalid API key" });
      }
      nextFn();
    });
  }

  // Lazy-init provider and signer
  let _provider: any = null;
  let _signer: any = null;
  let _pool: any = null;

  async function getPool() {
    if (!_pool) {
      const { ethers } = await import("ethers");
      _provider = new ethers.JsonRpcProvider(config.rpcUrl);
      _signer = new ethers.Wallet(config.signerPrivateKey, _provider);
      _pool = new ethers.Contract(config.poolAddress, POOL_ABI, _signer);
    }
    return _pool;
  }

  // POST /api/balance-request — trigger requestBalance() on-chain for a user
  // Note: only works if the gateway signer IS the user, or if pool supports
  // a delegated balance request. For now, users should call requestBalance()
  // from their own wallet and use GET /api/balance/:address to poll results.
  app.post("/api/balance-request", async (req: any, res: any) => {
    try {
      const ip = req.socket.remoteAddress || "unknown";
      if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: "Rate limit exceeded" });
      }

      const pool = await getPool();
      const tx = await pool.requestBalance();
      const receipt = await tx.wait();

      res.json({
        status: "requested",
        txHash: receipt.hash,
        message: "Balance snapshot created. Poll GET /api/balance/:address for result.",
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: msg });
    }
  });

  // GET /api/balance/:address — return decrypted balance or pending status
  app.get("/api/balance/:address", async (req: any, res: any) => {
    try {
      const ip = req.socket.remoteAddress || "unknown";
      if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: "Rate limit exceeded" });
      }

      const { address } = req.params;
      const { ethers } = await import("ethers");

      if (!ethers.isAddress(address)) {
        return res.status(400).json({ error: "Invalid address" });
      }

      const pool = await getPool();

      const isInit = await pool.isInitialized(address);
      if (!isInit) {
        return res.json({ address, status: "uninitialized", balance: null });
      }

      const queryRequested = await pool.balanceQueryRequested(address);
      if (!queryRequested) {
        return res.json({
          address,
          status: "no_snapshot",
          balance: null,
          message: "User must call requestBalance() first to create a decryptable snapshot.",
        });
      }

      // Snapshot exists — try to read it
      // Note: actual decryption requires the hardhat fhevm plugin (Node.js)
      // or the Zama gateway. In production, this would call the Zama decryption
      // gateway API. For now, return "pending" status.
      const snapshotHandle = await pool.balanceSnapshotOf(address);
      if (snapshotHandle === ethers.ZeroHash) {
        return res.json({ address, status: "pending", balance: null });
      }

      res.json({
        address,
        status: "pending",
        balance: null,
        snapshotHandle: snapshotHandle.toString(),
        message: "Snapshot exists. Use 'npx hardhat decrypt-balance' or Zama gateway to decrypt.",
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: msg });
    }
  });

  app.get("/health", (_req: any, res: any) => {
    res.json({ status: "ok", service: "fhe-x402-balance-gateway", timestamp: new Date().toISOString() });
  });

  return app;
}
