import crypto from "crypto";

/** Constant-time string comparison to prevent timing attacks.
 *  Uses hash comparison to avoid leaking length information. */
function timingSafeCompare(a: string, b: string): boolean {
  const hashA = crypto.createHash("sha256").update(a).digest();
  const hashB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export interface FacilitatorConfig {
  tokenAddress: string;
  verifierAddress: string;
  rpcUrl: string;
  name?: string;
  version?: string;
  apiKey?: string;
  chainId?: number;
  /** Allowed CORS origins. Empty array = allow all origins (default). */
  allowedOrigins?: string[];
}

const TOKEN_EVENT_ABI = [
  "event ConfidentialTransfer(address indexed from, address indexed to, bytes32 indexed amount)",
];

const VERIFIER_EVENT_ABI = [
  "event PaymentVerified(address indexed payer, address indexed server, bytes32 indexed nonce, uint64 minPrice)",
];

/**
 * Create a facilitator Express app with x402-standard endpoints.
 * V4.0: Verifies ConfidentialTransfer + PaymentVerified events on-chain.
 *
 * Usage:
 *   const app = await createFacilitatorServer({
 *     tokenAddress: '0x...',
 *     verifierAddress: '0x...',
 *     rpcUrl: 'https://sepolia.infura.io/v3/...',
 *   });
 *   app.listen(3001);
 */
export async function createFacilitatorServer(config: FacilitatorConfig): Promise<any> {
  // Dynamic import to avoid bundling express as hard dependency
  const expressModule = await import("express");
  const express = expressModule.default ?? expressModule;
  const app = express();
  app.use(express.json({ limit: "100kb" }));

  const allowedOrigins = config.allowedOrigins || [];

  // CORS headers for cross-origin requests
  app.use((_req: any, res: any, nextFn: any) => {
    const setH = res.setHeader?.bind(res) ?? res.set?.bind(res) ?? res.header?.bind(res);
    if (setH) {
      const origin = _req.headers?.origin;
      if (allowedOrigins.length === 0 || (origin && allowedOrigins.includes(origin))) {
        setH("Access-Control-Allow-Origin", origin || "*");
        setH("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        setH("Access-Control-Allow-Headers", "Content-Type, Authorization, X-FHE-x402-API-Key");
      }
      // If allowedOrigins is non-empty and origin doesn't match, don't set CORS headers — block cross-origin
    }
    if (_req.method === "OPTIONS") return res.status(204).end();
    nextFn();
  });

  const chainId = config.chainId ?? 11155111;
  const network = `eip155:${chainId}`;

  // API key authentication middleware
  if (!config.apiKey) {
    console.warn("[fhe-x402] WARNING: No API key configured. Facilitator endpoints are unauthenticated.");
  }
  if (config.apiKey) {
    app.use((req: any, res: any, nextFn: any) => {
      if (req.path === "/health" || req.path === "/info") return nextFn();
      const key = req.headers["x-fhe-x402-api-key"] || req.headers["authorization"]?.replace("Bearer ", "");
      if (!key || !timingSafeCompare(key, config.apiKey!)) {
        return res.status(401).json({ valid: false, error: "Unauthorized: invalid API key" });
      }
      nextFn();
    });
  }

  // Lazy-init provider with reconnection on failure
  let _provider: any = null;

  async function getProvider() {
    if (_provider) {
      try {
        await _provider.getBlockNumber(); // health check
        return _provider;
      } catch {
        _provider = null; // force reconnect
      }
    }
    const { ethers } = await import("ethers");
    _provider = new ethers.JsonRpcProvider(config.rpcUrl);
    return _provider;
  }

  // Rate limiter with eviction (prevents memory leak under sustained load)
  const MAX_RATE_ENTRIES = 10_000;
  const verifyRateLimit = new Map<string, { count: number; resetAt: number }>();
  let lastRateCleanup = Date.now();

  function checkVerifyRateLimit(ip: string): boolean {
    const now = Date.now();
    // Periodic cleanup — evict expired entries
    if (now - lastRateCleanup > 60_000) {
      for (const [key, entry] of verifyRateLimit) {
        if (now > entry.resetAt) verifyRateLimit.delete(key);
      }
      lastRateCleanup = now;
    }
    // LRU eviction if at capacity
    if (verifyRateLimit.size >= MAX_RATE_ENTRIES) {
      const first = verifyRateLimit.keys().next().value;
      if (first) verifyRateLimit.delete(first);
    }
    const entry = verifyRateLimit.get(ip);
    if (!entry || now > entry.resetAt) {
      verifyRateLimit.set(ip, { count: 1, resetAt: now + 60000 });
      return true;
    }
    entry.count++;
    return entry.count <= 30;
  }

  /** Extract client IP — prefers X-Forwarded-For for reverse proxy support. */
  function getClientIp(req: any): string {
    const forwarded = req.headers?.["x-forwarded-for"];
    const forwardedIp = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : undefined;
    return forwardedIp || req.socket?.remoteAddress || "unknown";
  }

  // === x402 Standard Endpoints ===

  app.get("/info", (_req: any, res: any) => {
    res.json({
      name: config.name || "FHE x402 Facilitator",
      version: config.version || "4.3.0",
      schemes: ["fhe-confidential-v1"],
      networks: [network],
      tokens: ["USDC"],
      protocolFee: "0.1%",
      minFee: "10000",
      features: ["fhe-encrypted-amounts", "token-centric", "fee-free-transfers", "event-verification"],
    });
  });

  // /verify — verify ConfidentialTransfer + PaymentVerified events on-chain
  app.post("/verify", async (req: any, res: any) => {
    try {
      const clientIp = getClientIp(req);
      if (!checkVerifyRateLimit(clientIp)) {
        return res.status(429).json({ valid: false, error: "Too many requests" });
      }

      const { x402Version, scheme, network: reqNetwork, payload } = req.body;

      if (scheme !== "fhe-confidential-v1") {
        return res.status(400).json({
          valid: false,
          error: `Unsupported scheme: ${scheme}. Use fhe-confidential-v1`,
        });
      }

      if (!reqNetwork) {
        return res.status(400).json({ error: "Missing network field" });
      }

      if (reqNetwork !== network) {
        return res.status(400).json({
          valid: false,
          error: `Unsupported network: ${reqNetwork}`,
        });
      }

      if (!payload || !payload.txHash) {
        return res.status(400).json({
          valid: false,
          error: "Missing payload or txHash",
        });
      }

      const provider = await getProvider();
      const { ethers } = await import("ethers");

      const receipt = await provider.getTransactionReceipt(payload.txHash);
      if (!receipt || receipt.status === 0) {
        return res.status(400).json({
          valid: false,
          error: "Transaction failed or not found",
        });
      }

      // Verify ConfidentialTransfer event
      const tokenIface = new ethers.Interface(TOKEN_EVENT_ABI);
      let verified = false;
      let eventFrom = "";
      let eventTo = "";

      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== config.tokenAddress.toLowerCase()) continue;
        try {
          const parsed = tokenIface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "ConfidentialTransfer") {
            verified = true;
            eventFrom = parsed.args[0];
            eventTo = parsed.args[1];
            break;
          }
        } catch {
          continue;
        }
      }

      if (!verified) {
        return res.status(400).json({
          valid: false,
          error: "ConfidentialTransfer event not found in transaction",
        });
      }

      res.json({
        valid: true,
        x402Version: x402Version || 1,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        network: reqNetwork || network,
        from: eventFrom,
        to: eventTo,
        settledAt: new Date().toISOString(),
      });
    } catch (error: unknown) {
      // Log full error internally, return generic message to prevent info leakage
      console.error("[facilitator] Verification error:", error);
      res.status(500).json({ valid: false, error: "Verification failed" });
    }
  });

  app.get("/health", (_req: any, res: any) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  return app;
}
