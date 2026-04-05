import crypto from "crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { JsonRpcProvider, ethers } from "ethers";
import type {
  FhePaymentRequirements,
  FhePaymentPayload,
  FheBatchPaymentPayload,
  FhePaymentRequired,
  FhePaywallConfig,
  PaymentInfo,
  NonceStore,
} from "./types.js";
import { FHE_SCHEME } from "./types.js";
import { verifyPaymentSignature } from "./fhePaymentHandler.js";

// ============================================================================
// Rate limiter factory (per-instance)
// ============================================================================

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * Creates a per-instance rate limiter. Each middleware closure gets its own
 * isolated store, preventing cross-route rate limit interference.
 */
function createRateLimiter(maxRate: number, windowMs: number) {
  const store = new Map<string, RateLimitEntry>();
  let lastCleanup = Date.now();
  const MAX_ENTRIES = 10_000;

  return function checkRateLimit(ip: string): boolean {
    const now = Date.now();

    // Evict expired entries periodically
    if (now - lastCleanup > windowMs) {
      for (const [key, entry] of store) {
        if (now > entry.resetAt) {
          store.delete(key);
        }
      }
      // LRU eviction if still over capacity
      if (store.size > MAX_ENTRIES) {
        const entriesToDelete = store.size - MAX_ENTRIES;
        let deleted = 0;
        for (const key of store.keys()) {
          if (deleted >= entriesToDelete) break;
          store.delete(key);
          deleted++;
        }
      }
      lastCleanup = now;
    }

    const entry = store.get(ip);
    if (!entry || now > entry.resetAt) {
      store.set(ip, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= maxRate;
  };
}

// ============================================================================
// Client IP resolution
// ============================================================================

function getClientIp(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const forwardedIp = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : undefined;
    if (forwardedIp) return forwardedIp;
  }
  return req.socket?.remoteAddress || "unknown";
}

// ============================================================================
// Default in-memory nonce store
// ============================================================================

class InMemoryNonceStore implements NonceStore {
  private nonces = new Map<string, number>(); // nonce → expiry timestamp
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(maxEntries: number = 100_000, ttlMs: number = 86_400_000) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  /** Atomic check-and-add: returns true if nonce is new, false if replay.
   *  Single-threaded JS makes this naturally atomic within one process.
   *  For multi-instance deployments, use RedisNonceStore instead. */
  checkAndAdd(nonce: string): boolean {
    const expiry = this.nonces.get(nonce);
    if (expiry !== undefined && Date.now() <= expiry) {
      return false; // Nonce exists and not expired → replay
    }
    // Evict expired entries if at capacity
    if (this.nonces.size >= this.maxEntries) {
      const now = Date.now();
      for (const [key, exp] of this.nonces) {
        if (now > exp) this.nonces.delete(key);
      }
      if (this.nonces.size >= this.maxEntries) {
        const first = this.nonces.keys().next().value;
        if (first) this.nonces.delete(first);
      }
    }
    this.nonces.set(nonce, Date.now() + this.ttlMs);
    return true; // New nonce, added
  }
}

// ============================================================================
// Express global augmentation
// ============================================================================

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      paymentInfo?: PaymentInfo;
    }
  }
}

// ============================================================================
// Middleware
// ============================================================================

// ============================================================================
// Webhook + callback helpers
// ============================================================================

/** Fire webhook POST (fire-and-forget, never throws) */
function fireWebhook(
  config: FhePaywallConfig,
  payload: { event: string; requestId: string; payer: string; nonce: string; amount: string; timestamp: string }
): void {
  if (!config.webhookUrl) return;
  try {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.webhookSecret) {
      const hmac = crypto.createHmac("sha256", config.webhookSecret).update(body).digest("hex");
      headers["X-Webhook-Signature"] = hmac;
    }
    // Fire-and-forget: intentionally not awaited
    fetch(config.webhookUrl, { method: "POST", headers, body }).catch(() => {});
  } catch {
    // Never let webhook errors propagate
  }
}

/** Safely invoke onPaymentVerified callback */
function safeOnPaymentVerified(
  config: FhePaywallConfig,
  info: { requestId: string; payer: string; nonce: string; amount: string; latencyMs: number }
): void {
  if (!config.onPaymentVerified) return;
  try {
    config.onPaymentVerified(info);
  } catch {
    // Never let callback errors break the middleware
  }
}

/** Safely invoke onPaymentFailed callback */
function safeOnPaymentFailed(
  config: FhePaywallConfig,
  info: { requestId: string; error: string; latencyMs: number }
): void {
  if (!config.onPaymentFailed) return;
  try {
    config.onPaymentFailed(info);
  } catch {
    // Never let callback errors break the middleware
  }
}

const TOKEN_EVENT_ABI = [
  "event ConfidentialTransfer(address indexed from, address indexed to, bytes32 indexed amount)",
];

const VERIFIER_EVENT_ABI = [
  "event PaymentVerified(address indexed payer, address indexed server, bytes32 indexed nonce, uint64 minPrice)",
];

const PAY_AND_RECORD_EVENT_ABI = [
  "event PayAndRecordCompleted(address indexed payer, address indexed server, bytes32 indexed nonce, address token, uint64 minPrice)",
];

const BATCH_VERIFIER_EVENT_ABI = [
  "event BatchPaymentRecorded(address indexed payer, address indexed server, bytes32 indexed nonce, uint32 requestCount, uint64 pricePerRequest)",
];

// ============================================================================
// V4.3 — Batch credit store (in-memory)
// ============================================================================

interface BatchCredit {
  remaining: number;
  pricePerRequest: bigint;
  payer: string;
  server: string;
  createdAt: number;
}

const MAX_BATCH_CREDITS = 50_000;
const BATCH_CREDIT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Creates a per-instance batch credit store. Each fheBatchPaywall() call gets its own
 * isolated store, preventing cross-route credit consumption (e.g., buying cheap credits
 * on /api/basic and using them on /api/premium).
 */
function createBatchCreditStore() {
  const store: Map<string, BatchCredit> = new Map();

  function key(payer: string, nonce: string): string {
    return `${payer.toLowerCase()}:${nonce}`;
  }

  function cleanExpired(): void {
    const now = Date.now();
    for (const [k, credit] of store) {
      if (now - credit.createdAt > BATCH_CREDIT_TTL_MS) store.delete(k);
    }
  }

  return {
    consume(payer: string, nonce: string): boolean {
      const k = key(payer, nonce);
      const credit = store.get(k);
      if (!credit || credit.remaining <= 0) return false;
      credit.remaining--;
      if (credit.remaining === 0) store.delete(k);
      return true;
    },

    register(payer: string, server: string, nonce: string, requestCount: number, pricePerRequest: bigint): void {
      const k = key(payer, nonce);
      if (store.has(k)) return; // prevent overwrite
      if (store.size >= MAX_BATCH_CREDITS) cleanExpired();
      // LRU eviction if still at capacity after cleanup
      if (store.size >= MAX_BATCH_CREDITS) {
        const first = store.keys().next().value;
        if (first) store.delete(first);
      }
      store.set(k, {
        remaining: requestCount,
        pricePerRequest,
        payer: payer.toLowerCase(),
        server: server.toLowerCase(),
        createdAt: Date.now(),
      });
    },

    get(payer: string, nonce: string): number {
      const k = key(payer, nonce);
      return store.get(k)?.remaining ?? 0;
    },

    getCreatedAt(payer: string, nonce: string): number {
      const k = key(payer, nonce);
      return store.get(k)?.createdAt ?? 0;
    },
  };
}

/**
 * Express middleware that puts an FHE x402 paywall on a route.
 *
 * V4.0: Verifies ConfidentialTransfer event (from cUSDC token) + PaymentVerified event (from verifier).
 *
 * No Payment header → 402 with requirements.
 * Has Payment header → decode, verify events on-chain, call next().
 */
export function fhePaywall(config: FhePaywallConfig): RequestHandler {
  if (!ethers.isAddress(config.tokenAddress)) {
    throw new Error(`Invalid token address: ${config.tokenAddress}`);
  }
  if (!ethers.isAddress(config.verifierAddress)) {
    throw new Error(`Invalid verifier address: ${config.verifierAddress}`);
  }
  if (!ethers.isAddress(config.recipientAddress)) {
    throw new Error(`Invalid recipient address: ${config.recipientAddress}`);
  }

  const chainId = config.chainId ?? 11155111;
  const network = `eip155:${chainId}`;
  const maxTimeout = config.maxTimeoutSeconds ?? 300;
  const maxRate = config.maxRateLimit ?? 60;
  const rateWindow = config.rateLimitWindowMs ?? 60000;
  const minConfirmations = config.minConfirmations ?? 1;
  const rpcTimeout = config.rpcTimeoutMs ?? 30_000;
  const trustProxy = config.trustProxy ?? false;
  const provider = new JsonRpcProvider(config.rpcUrl);
  const nonceStore: NonceStore = config.nonceStore ?? new InMemoryNonceStore();

  // Per-instance rate limiter
  const checkRate = createRateLimiter(maxRate, rateWindow);

  // Cached Interface objects (avoid re-parsing ABI per request)
  const tokenIface = new ethers.Interface(TOKEN_EVENT_ABI);
  const verifierIface = new ethers.Interface(VERIFIER_EVENT_ABI);
  const payAndRecordIface = new ethers.Interface(PAY_AND_RECORD_EVENT_ABI);

  // [C2] Nonce mutex — prevent race condition where two concurrent requests
  // use the same nonce before either's on-chain verification completes.
  // Ported from PrivAgent middlewareV2.ts pendingNullifiers pattern.
  const pendingNonces = new Set<string>();

  return async (req: Request, res: Response, next: NextFunction) => {
    // Assign request ID for correlation
    const requestId = crypto.randomUUID();
    const startTime = Date.now();
    res.setHeader("X-Request-Id", requestId);

    // Rate limiting
    const clientIp = getClientIp(req, trustProxy);
    if (!checkRate(clientIp)) {
      res.status(429).json({ error: "Too many requests" });
      return;
    }

    const paymentHeader = req.headers["payment"] as string | undefined;

    // ===== No Payment header → return 402 =====
    if (!paymentHeader) {
      const requestUrl = `${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`;

      const requirements: FhePaymentRequirements = {
        scheme: FHE_SCHEME,
        network,
        chainId,
        price: String(config.price),
        asset: config.asset,
        tokenAddress: config.tokenAddress,
        verifierAddress: config.verifierAddress,
        recipientAddress: config.recipientAddress,
        maxTimeoutSeconds: maxTimeout,
      };

      const body: FhePaymentRequired = {
        x402Version: 1,
        accepts: [requirements],
        resource: {
          url: requestUrl,
          method: req.method,
        },
      };

      res.status(402).json(body);
      return;
    }

    // ===== Decode Payment header =====
    const MAX_PAYLOAD_SIZE = 100 * 1024;
    if (paymentHeader.length > MAX_PAYLOAD_SIZE) {
      safeOnPaymentFailed(config, { requestId, error: "Payment header too large", latencyMs: Date.now() - startTime });
      res.status(400).json({ error: "Payment header too large" });
      return;
    }

    let payload: FhePaymentPayload;
    try {
      const json = Buffer.from(paymentHeader, "base64").toString("utf-8");
      payload = JSON.parse(json) as FhePaymentPayload;
    } catch {
      safeOnPaymentFailed(config, {
        requestId,
        error: "Invalid Payment header encoding",
        latencyMs: Date.now() - startTime,
      });
      res.status(400).json({ error: "Invalid Payment header encoding" });
      return;
    }

    // Validate structure
    if (payload.scheme !== FHE_SCHEME) {
      safeOnPaymentFailed(config, {
        requestId,
        error: "Unsupported payment scheme",
        latencyMs: Date.now() - startTime,
      });
      res.status(400).json({ error: "Unsupported payment scheme" });
      return;
    }
    if (!payload.txHash || !payload.nonce || !payload.from) {
      safeOnPaymentFailed(config, {
        requestId,
        error: "Missing required payment fields",
        latencyMs: Date.now() - startTime,
      });
      res.status(400).json({ error: "Missing required payment fields" });
      return;
    }

    if (!ethers.isAddress(payload.from)) {
      safeOnPaymentFailed(config, {
        requestId,
        error: "Invalid sender address format",
        latencyMs: Date.now() - startTime,
      });
      res.status(400).json({ error: "Invalid sender address format" });
      return;
    }

    // Chain ID verification — reject payments from wrong chain
    if (payload.chainId !== chainId) {
      safeOnPaymentFailed(config, {
        requestId,
        error: `Chain ID mismatch: expected ${chainId}, got ${payload.chainId}`,
        latencyMs: Date.now() - startTime,
      });
      res.status(400).json({ error: `Chain ID mismatch: expected ${chainId}, got ${payload.chainId}` });
      return;
    }

    // Validate nonce format — must be 32-byte hex string
    if (!/^0x[0-9a-fA-F]{64}$/.test(payload.nonce)) {
      res.status(400).json({ error: "Invalid nonce format — expected 0x + 64 hex chars" });
      return;
    }

    // Verify ECDSA signature — prevent payment header forgery
    if (!verifyPaymentSignature(payload)) {
      res.status(400).json({ error: "Invalid payment signature" });
      return;
    }

    // [C2] Nonce mutex — reject if another request is already processing this nonce
    if (pendingNonces.has(payload.nonce)) {
      res.status(409).json({ error: "Payment already being processed" });
      return;
    }
    pendingNonces.add(payload.nonce);

    try {
      // Nonce replay prevention — atomic check-and-add (TOCTOU-safe)
      const isNew = await nonceStore.checkAndAdd(payload.nonce);
      if (!isNew) {
        pendingNonces.delete(payload.nonce);
        res.status(400).json({ error: "Nonce already used" });
        return;
      }

      // ===== Verify on-chain events =====
      try {
        // Verify ConfidentialTransfer event (from cUSDC token)
        const receipt = await Promise.race([
          provider.getTransactionReceipt(payload.txHash),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), rpcTimeout)),
        ]);
        if (!receipt || receipt.status === 0) {
          res.status(400).json({ error: "Transaction failed or not found" });
          return;
        }

        // Confirmation depth check
        if (minConfirmations > 1) {
          const currentBlock = await provider.getBlockNumber();
          const confirmations = currentBlock - receipt.blockNumber + 1;
          if (confirmations < minConfirmations) {
            res.status(400).json({
              error: `Insufficient confirmations: ${confirmations}/${minConfirmations}`,
            });
            return;
          }
        }

        // Parse ConfidentialTransfer event (uses cached tokenIface)
        let transferVerified = false;

        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== config.tokenAddress.toLowerCase()) continue;
          try {
            const parsed = tokenIface.parseLog({ topics: log.topics as string[], data: log.data });
            if (
              parsed?.name === "ConfidentialTransfer" &&
              parsed.args[0].toLowerCase() === payload.from.toLowerCase() &&
              parsed.args[1].toLowerCase() === config.recipientAddress.toLowerCase()
            ) {
              transferVerified = true;
              break;
            }
          } catch {
            // Event parsing expected to fail for non-matching logs
            continue;
          }
        }

        if (!transferVerified) {
          res.status(400).json({ error: "ConfidentialTransfer event not found or mismatched" });
          return;
        }

        // Silent failure heuristic: verify sender's balance handle changed
        // This catches the common case where FHE.select() returns 0 on insufficient balance
        try {
          const senderBalanceHandle: string = await provider.call({
            to: config.tokenAddress,
            data: new ethers.Interface([
              "function confidentialBalanceOf(address) view returns (bytes32)",
            ]).encodeFunctionData("confidentialBalanceOf", [payload.from]),
          });
          // Note: We can't decrypt the handle, but a zero handle means no balance at all
          const ZERO_HANDLE = "0x" + "00".repeat(32);
          if (senderBalanceHandle === ZERO_HANDLE || senderBalanceHandle === "0x") {
            // Sender's encrypted balance is zero — transfer was definitely 0
            res.status(400).json({ error: "Silent failure detected: sender has zero encrypted balance" });
            return;
          }
        } catch {
          // Balance check failed — proceed without heuristic (non-blocking)
        }

        // Verify nonce event — dual-TX (PaymentVerified) or single-TX (PayAndRecordCompleted)
        if (payload.verifierTxHash) {
          // V4.0/V4.1 dual-TX: PaymentVerified in separate verifier transaction
          const vReceipt = await Promise.race([
            provider.getTransactionReceipt(payload.verifierTxHash),
            new Promise<null>((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), rpcTimeout)),
          ]);
          if (!vReceipt || vReceipt.status === 0) {
            res.status(400).json({ error: "Verifier transaction failed or not found" });
            return;
          }

          let nonceVerified = false;

          const requiredPrice = BigInt(config.price);

          for (const log of vReceipt.logs) {
            if (log.address.toLowerCase() !== config.verifierAddress.toLowerCase()) continue;
            try {
              const parsed = verifierIface.parseLog({ topics: log.topics as string[], data: log.data });
              if (
                parsed?.name === "PaymentVerified" &&
                parsed.args[0].toLowerCase() === payload.from.toLowerCase() &&
                parsed.args[1].toLowerCase() === config.recipientAddress.toLowerCase() &&
                parsed.args[2] === payload.nonce
              ) {
                // V4.1: Verify minPrice >= required price
                const eventMinPrice = BigInt(parsed.args[3]);
                if (eventMinPrice < requiredPrice) {
                  res.status(400).json({
                    error: `Insufficient minPrice: committed ${eventMinPrice}, required ${requiredPrice}`,
                  });
                  return;
                }
                nonceVerified = true;
                break;
              }
            } catch {
              // Event parsing expected to fail for non-matching logs
              continue;
            }
          }

          if (!nonceVerified) {
            res.status(400).json({ error: "PaymentVerified event not found or mismatched" });
            return;
          }
        } else {
          // V4.2 single-TX: PayAndRecordCompleted in same receipt as ConfidentialTransfer (uses cached payAndRecordIface)
          let singleTxVerified = false;
          const requiredPrice = BigInt(config.price);

          for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== config.verifierAddress.toLowerCase()) continue;
            try {
              const parsed = payAndRecordIface.parseLog({ topics: log.topics as string[], data: log.data });
              if (
                parsed?.name === "PayAndRecordCompleted" &&
                parsed.args[0].toLowerCase() === payload.from.toLowerCase() &&
                parsed.args[1].toLowerCase() === config.recipientAddress.toLowerCase() &&
                parsed.args[2] === payload.nonce
              ) {
                // Verify token address matches
                if (parsed.args[3].toLowerCase() !== config.tokenAddress.toLowerCase()) {
                  continue;
                }
                // Verify minPrice >= required price
                const eventMinPrice = BigInt(parsed.args[4]);
                if (eventMinPrice < requiredPrice) {
                  res.status(400).json({
                    error: `Insufficient minPrice: committed ${eventMinPrice}, required ${requiredPrice}`,
                  });
                  return;
                }
                singleTxVerified = true;
                break;
              }
            } catch {
              // Event parsing expected to fail for non-matching logs
              continue;
            }
          }

          if (!singleTxVerified) {
            res.status(400).json({ error: "PayAndRecordCompleted event not found or mismatched" });
            return;
          }
        }

        // Attach payment info
        req.paymentInfo = {
          from: payload.from,
          amount: String(config.price),
          asset: config.asset,
          recipient: config.recipientAddress,
          txHash: payload.txHash,
          verifierTxHash: payload.verifierTxHash || "",
          nonce: payload.nonce,
          blockNumber: receipt.blockNumber,
        };

        res.setHeader("X-Payment-TxHash", payload.txHash);
        safeOnPaymentVerified(config, {
          requestId,
          payer: payload.from,
          nonce: payload.nonce,
          amount: String(config.price),
          latencyMs: Date.now() - startTime,
        });
        fireWebhook(config, {
          event: "payment.verified",
          requestId,
          payer: payload.from,
          nonce: payload.nonce,
          amount: String(config.price),
          timestamp: new Date().toISOString(),
        });
        next();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        safeOnPaymentFailed(config, { requestId, error: errMsg, latencyMs: Date.now() - startTime });
        if (err instanceof Error && err.message === "RPC timeout") {
          res.status(504).json({ error: "RPC timeout during payment verification" });
          return;
        }
        console.error("[fhe-x402] Verification failed:", err instanceof Error ? err.message : err);
        res.status(500).json({ error: "Payment verification failed" });
      }
    } finally {
      // [C2] Always release nonce mutex
      pendingNonces.delete(payload.nonce);
    }
  };
}

// ============================================================================
// V4.3 — Batch paywall middleware
// ============================================================================

/**
 * Express middleware that puts an FHE x402 paywall with batch prepayment support.
 *
 * Supports two payment modes:
 * 1. Single payment (same as fhePaywall) — one-time per-request payment
 * 2. Batch payment — agent prepays for N requests; middleware tracks remaining credits
 *
 * Batch flow:
 * - First request: agent sends batch payment header with requestCount + pricePerRequest
 * - Middleware verifies BatchPaymentRecorded event, registers credits
 * - Subsequent requests: agent sends same nonce, middleware deducts one credit
 * - When credits exhausted: middleware returns 402 again
 */
export function fheBatchPaywall(config: FhePaywallConfig): RequestHandler {
  if (!ethers.isAddress(config.tokenAddress)) {
    throw new Error(`Invalid token address: ${config.tokenAddress}`);
  }
  if (!ethers.isAddress(config.verifierAddress)) {
    throw new Error(`Invalid verifier address: ${config.verifierAddress}`);
  }
  if (!ethers.isAddress(config.recipientAddress)) {
    throw new Error(`Invalid recipient address: ${config.recipientAddress}`);
  }

  const chainId = config.chainId ?? 11155111;
  const network = `eip155:${chainId}`;
  const maxTimeout = config.maxTimeoutSeconds ?? 300;
  const maxRate = config.maxRateLimit ?? 60;
  // Per-instance batch credit store — prevents cross-route credit consumption
  const batchCredits = createBatchCreditStore();
  const rateWindow = config.rateLimitWindowMs ?? 60000;
  const minConfirmations = config.minConfirmations ?? 1;
  const rpcTimeout = config.rpcTimeoutMs ?? 30_000;
  const trustProxy = config.trustProxy ?? false;
  const provider = new JsonRpcProvider(config.rpcUrl);
  const nonceStore: NonceStore = config.nonceStore ?? new InMemoryNonceStore();

  // Per-instance rate limiter
  const checkRate = createRateLimiter(maxRate, rateWindow);

  // Cached Interface objects (avoid re-parsing ABI per request)
  const batchTokenIface = new ethers.Interface(TOKEN_EVENT_ABI);
  const batchVerifierIface = new ethers.Interface(BATCH_VERIFIER_EVENT_ABI);
  const batchSingleVerifierIface = new ethers.Interface(VERIFIER_EVENT_ABI);
  const batchPayAndRecordIface = new ethers.Interface(PAY_AND_RECORD_EVENT_ABI);

  // [C2] Nonce mutex — prevent race condition where two concurrent batch requests
  // use the same nonce before either's on-chain verification completes.
  // Ported from PrivAgent middlewareV2.ts pendingNullifiers pattern.
  const pendingBatchNonces = new Set<string>();

  return async (req: Request, res: Response, next: NextFunction) => {
    // Assign request ID for correlation
    const requestId = crypto.randomUUID();
    const startTime = Date.now();
    res.setHeader("X-Request-Id", requestId);

    // Rate limiting
    const clientIp = getClientIp(req, trustProxy);
    if (!checkRate(clientIp)) {
      res.status(429).json({ error: "Too many requests" });
      return;
    }

    const paymentHeader = req.headers["payment"] as string | undefined;

    // ===== No Payment header → return 402 =====
    if (!paymentHeader) {
      const requestUrl = `${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`;

      const requirements: FhePaymentRequirements = {
        scheme: FHE_SCHEME,
        network,
        chainId,
        price: String(config.price),
        asset: config.asset,
        tokenAddress: config.tokenAddress,
        verifierAddress: config.verifierAddress,
        recipientAddress: config.recipientAddress,
        maxTimeoutSeconds: maxTimeout,
      };

      const body: FhePaymentRequired = {
        x402Version: 1,
        accepts: [requirements],
        resource: {
          url: requestUrl,
          method: req.method,
        },
      };

      res.status(402).json(body);
      return;
    }

    // ===== Decode Payment header =====
    const MAX_PAYLOAD_SIZE = 100 * 1024;
    if (paymentHeader.length > MAX_PAYLOAD_SIZE) {
      safeOnPaymentFailed(config, { requestId, error: "Payment header too large", latencyMs: Date.now() - startTime });
      res.status(400).json({ error: "Payment header too large" });
      return;
    }

    let rawPayload: Record<string, unknown>;
    try {
      const json = Buffer.from(paymentHeader, "base64").toString("utf-8");
      rawPayload = JSON.parse(json) as Record<string, unknown>;
    } catch {
      safeOnPaymentFailed(config, {
        requestId,
        error: "Invalid Payment header encoding",
        latencyMs: Date.now() - startTime,
      });
      res.status(400).json({ error: "Invalid Payment header encoding" });
      return;
    }

    if (rawPayload.scheme !== FHE_SCHEME) {
      safeOnPaymentFailed(config, {
        requestId,
        error: "Unsupported payment scheme",
        latencyMs: Date.now() - startTime,
      });
      res.status(400).json({ error: "Unsupported payment scheme" });
      return;
    }
    if (!rawPayload.txHash || !rawPayload.nonce || !rawPayload.from) {
      safeOnPaymentFailed(config, {
        requestId,
        error: "Missing required payment fields",
        latencyMs: Date.now() - startTime,
      });
      res.status(400).json({ error: "Missing required payment fields" });
      return;
    }

    if (typeof rawPayload.from === "string" && !ethers.isAddress(rawPayload.from)) {
      safeOnPaymentFailed(config, {
        requestId,
        error: "Invalid sender address format",
        latencyMs: Date.now() - startTime,
      });
      res.status(400).json({ error: "Invalid sender address format" });
      return;
    }

    if (rawPayload.chainId !== chainId) {
      safeOnPaymentFailed(config, {
        requestId,
        error: `Chain ID mismatch: expected ${chainId}, got ${rawPayload.chainId}`,
        latencyMs: Date.now() - startTime,
      });
      res.status(400).json({ error: `Chain ID mismatch: expected ${chainId}, got ${rawPayload.chainId}` });
      return;
    }

    if (typeof rawPayload.from !== "string" || typeof rawPayload.nonce !== "string") {
      safeOnPaymentFailed(config, {
        requestId,
        error: "Invalid payment payload: from and nonce must be strings",
        latencyMs: Date.now() - startTime,
      });
      res.status(400).json({ error: "Invalid payment payload: from and nonce must be strings" });
      return;
    }

    // Validate nonce format — must be 32-byte hex string
    if (!/^0x[0-9a-fA-F]{64}$/.test(rawPayload.nonce as string)) {
      safeOnPaymentFailed(config, { requestId, error: "Invalid nonce format", latencyMs: Date.now() - startTime });
      res.status(400).json({ error: "Invalid nonce format — expected 0x + 64 hex chars" });
      return;
    }

    // Verify ECDSA signature — prevent payment header forgery
    if (!verifyPaymentSignature(rawPayload as unknown as FhePaymentPayload)) {
      res.status(400).json({ error: "Invalid payment signature" });
      return;
    }

    const isBatch = typeof rawPayload.requestCount === "number" && typeof rawPayload.pricePerRequest === "string";
    const payerAddress = rawPayload.from as string;
    const nonce = rawPayload.nonce as string;

    // [C2] Nonce mutex check — reject if same nonce is already being processed
    if (pendingBatchNonces.has(nonce)) {
      res.status(409).json({ error: "Payment already being processed" });
      return;
    }
    pendingBatchNonces.add(nonce);

    try {
      // ===== Check for existing batch credits =====
      // NOTE: Batch credits are only consumed for known nonces that were already
      // verified on-chain during initial registration. The nonce was added to the
      // nonceStore when the batch was first registered, so a replay of an unknown
      // nonce will be caught by the nonce check below. We still need to verify
      // the nonce belongs to a registered batch before consuming credits.
      if (isBatch) {
        // Try to consume a batch credit from the per-instance store
        const hasCredit = batchCredits.consume(payerAddress, nonce);
        if (hasCredit) {
          // Credit consumed — allow through without on-chain verification
          req.paymentInfo = {
            from: payerAddress,
            amount: String((rawPayload as unknown as FheBatchPaymentPayload).pricePerRequest),
            asset: config.asset,
            recipient: config.recipientAddress,
            txHash: rawPayload.txHash as string,
            verifierTxHash: (rawPayload.verifierTxHash as string) || "",
            nonce,
            blockNumber: 0, // batch credit — no new block
          };
          res.setHeader("X-Payment-TxHash", rawPayload.txHash as string);
          const remaining = batchCredits.get(payerAddress, nonce);
          res.setHeader("X-Batch-Credits-Remaining", String(remaining));
          // Warn if batch credits are expiring soon (< 1 hour remaining in TTL)
          const createdAt = batchCredits.getCreatedAt(payerAddress, nonce);
          if (createdAt > 0) {
            const expiresAt = createdAt + BATCH_CREDIT_TTL_MS;
            const msUntilExpiry = expiresAt - Date.now();
            if (msUntilExpiry < 3_600_000) {
              res.setHeader(
                "X-Batch-Credits-Expiry-Warning",
                `Credits expire in ${Math.max(0, Math.floor(msUntilExpiry / 1000))}s`
              );
            }
          }
          safeOnPaymentVerified(config, {
            requestId,
            payer: payerAddress,
            nonce,
            amount: String((rawPayload as unknown as FheBatchPaymentPayload).pricePerRequest),
            latencyMs: Date.now() - startTime,
          });
          fireWebhook(config, {
            event: "payment.verified",
            requestId,
            payer: payerAddress,
            nonce,
            amount: String((rawPayload as unknown as FheBatchPaymentPayload).pricePerRequest),
            timestamp: new Date().toISOString(),
          });
          next();
          return;
        }
      }

      // ===== Nonce replay prevention — atomic check-and-add (TOCTOU-safe) =====
      const isNew = await nonceStore.checkAndAdd(nonce);
      if (!isNew) {
        if (isBatch) {
          res.status(402).json({ error: "Batch credits exhausted", nonce });
          return;
        }
        res.status(400).json({ error: "Nonce already used" });
        return;
      }

      // ===== Verify on-chain events =====
      try {
        const txHash = rawPayload.txHash as string;
        const receipt = await Promise.race([
          provider.getTransactionReceipt(txHash),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), rpcTimeout)),
        ]);
        if (!receipt || receipt.status === 0) {
          res.status(400).json({ error: "Transaction failed or not found" });
          return;
        }

        // Confirmation depth check
        if (minConfirmations > 1) {
          const currentBlock = await provider.getBlockNumber();
          const confirmations = currentBlock - receipt.blockNumber + 1;
          if (confirmations < minConfirmations) {
            res.status(400).json({
              error: `Insufficient confirmations: ${confirmations}/${minConfirmations}`,
            });
            return;
          }
        }

        // Verify ConfidentialTransfer event (uses cached batchTokenIface)
        let transferVerified = false;

        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== config.tokenAddress.toLowerCase()) continue;
          try {
            const parsed = batchTokenIface.parseLog({ topics: log.topics as string[], data: log.data });
            if (
              parsed?.name === "ConfidentialTransfer" &&
              parsed.args[0].toLowerCase() === payerAddress.toLowerCase() &&
              parsed.args[1].toLowerCase() === config.recipientAddress.toLowerCase()
            ) {
              transferVerified = true;
              break;
            }
          } catch {
            // Event parsing expected to fail for non-matching logs
            continue;
          }
        }

        if (!transferVerified) {
          res.status(400).json({ error: "ConfidentialTransfer event not found or mismatched" });
          return;
        }

        // ===== Batch vs single verification =====
        const verifierTxHash = rawPayload.verifierTxHash as string;

        if (isBatch && verifierTxHash) {
          // V4.3: Verify BatchPaymentRecorded event
          const vReceipt = await Promise.race([
            provider.getTransactionReceipt(verifierTxHash),
            new Promise<null>((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), rpcTimeout)),
          ]);
          if (!vReceipt || vReceipt.status === 0) {
            res.status(400).json({ error: "Verifier transaction failed or not found" });
            return;
          }

          let batchVerified = false;

          // Explicit type guard before casting batch payload
          if (
            typeof rawPayload.requestCount !== "number" ||
            rawPayload.requestCount <= 0 ||
            typeof rawPayload.pricePerRequest !== "string" ||
            !rawPayload.pricePerRequest
          ) {
            res.status(400).json({ error: "Invalid batch payload: missing requestCount or pricePerRequest" });
            return;
          }
          // Reject zero or negative pricePerRequest
          if (BigInt(rawPayload.pricePerRequest as string) <= 0n) {
            res.status(400).json({ error: "Invalid batch payload: pricePerRequest must be > 0" });
            return;
          }
          const batchPayload = rawPayload as unknown as FheBatchPaymentPayload;
          const requiredPrice = BigInt(config.price);

          for (const log of vReceipt.logs) {
            if (log.address.toLowerCase() !== config.verifierAddress.toLowerCase()) continue;
            try {
              const parsed = batchVerifierIface.parseLog({ topics: log.topics as string[], data: log.data });
              if (
                parsed?.name === "BatchPaymentRecorded" &&
                parsed.args[0].toLowerCase() === payerAddress.toLowerCase() &&
                parsed.args[1].toLowerCase() === config.recipientAddress.toLowerCase() &&
                parsed.args[2] === nonce
              ) {
                const eventRequestCount = Number(parsed.args[3]);
                const eventPricePerRequest = BigInt(parsed.args[4]);

                // Verify pricePerRequest >= required price
                if (eventPricePerRequest < requiredPrice) {
                  res.status(400).json({
                    error: `Insufficient pricePerRequest: ${eventPricePerRequest}, required ${requiredPrice}`,
                  });
                  return;
                }

                // Register credits (minus 1 for this request) in per-instance store
                batchCredits.register(
                  payerAddress,
                  config.recipientAddress,
                  nonce,
                  eventRequestCount - 1,
                  eventPricePerRequest
                );

                batchVerified = true;
                break;
              }
            } catch {
              // Event parsing expected to fail for non-matching logs
              continue;
            }
          }

          if (!batchVerified) {
            res.status(400).json({ error: "BatchPaymentRecorded event not found or mismatched" });
            return;
          }

          req.paymentInfo = {
            from: payerAddress,
            amount: batchPayload.pricePerRequest,
            asset: config.asset,
            recipient: config.recipientAddress,
            txHash,
            verifierTxHash,
            nonce,
            blockNumber: receipt.blockNumber,
          };

          res.setHeader("X-Payment-TxHash", txHash);
          res.setHeader("X-Batch-Credits-Remaining", String(batchCredits.get(payerAddress, nonce)));
          safeOnPaymentVerified(config, {
            requestId,
            payer: payerAddress,
            nonce,
            amount: batchPayload.pricePerRequest,
            latencyMs: Date.now() - startTime,
          });
          fireWebhook(config, {
            event: "payment.verified",
            requestId,
            payer: payerAddress,
            nonce,
            amount: batchPayload.pricePerRequest,
            timestamp: new Date().toISOString(),
          });
          next();
        } else if (verifierTxHash) {
          // V4.0/V4.1: Verify PaymentVerified event (single payment)
          const vReceipt = await Promise.race([
            provider.getTransactionReceipt(verifierTxHash),
            new Promise<null>((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), rpcTimeout)),
          ]);
          if (!vReceipt || vReceipt.status === 0) {
            res.status(400).json({ error: "Verifier transaction failed or not found" });
            return;
          }

          let nonceVerified = false;
          const requiredPrice = BigInt(config.price);

          for (const log of vReceipt.logs) {
            if (log.address.toLowerCase() !== config.verifierAddress.toLowerCase()) continue;
            try {
              const parsed = batchSingleVerifierIface.parseLog({ topics: log.topics as string[], data: log.data });
              if (
                parsed?.name === "PaymentVerified" &&
                parsed.args[0].toLowerCase() === payerAddress.toLowerCase() &&
                parsed.args[1].toLowerCase() === config.recipientAddress.toLowerCase() &&
                parsed.args[2] === nonce
              ) {
                const eventMinPrice = BigInt(parsed.args[3]);
                if (eventMinPrice < requiredPrice) {
                  res.status(400).json({
                    error: `Insufficient minPrice: committed ${eventMinPrice}, required ${requiredPrice}`,
                  });
                  return;
                }
                nonceVerified = true;
                break;
              }
            } catch {
              // Event parsing expected to fail for non-matching logs
              continue;
            }
          }

          if (!nonceVerified) {
            res.status(400).json({ error: "PaymentVerified event not found or mismatched" });
            return;
          }

          req.paymentInfo = {
            from: payerAddress,
            amount: String(config.price),
            asset: config.asset,
            recipient: config.recipientAddress,
            txHash,
            verifierTxHash,
            nonce,
            blockNumber: receipt.blockNumber,
          };

          res.setHeader("X-Payment-TxHash", txHash);
          safeOnPaymentVerified(config, {
            requestId,
            payer: payerAddress,
            nonce,
            amount: String(config.price),
            latencyMs: Date.now() - startTime,
          });
          fireWebhook(config, {
            event: "payment.verified",
            requestId,
            payer: payerAddress,
            nonce,
            amount: String(config.price),
            timestamp: new Date().toISOString(),
          });
          next();
        } else {
          // V4.2 single-TX: PayAndRecordCompleted in same receipt as ConfidentialTransfer (uses cached batchPayAndRecordIface)
          let singleTxVerified = false;
          const requiredPrice = BigInt(config.price);

          for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== config.verifierAddress.toLowerCase()) continue;
            try {
              const parsed = batchPayAndRecordIface.parseLog({ topics: log.topics as string[], data: log.data });
              if (
                parsed?.name === "PayAndRecordCompleted" &&
                parsed.args[0].toLowerCase() === payerAddress.toLowerCase() &&
                parsed.args[1].toLowerCase() === config.recipientAddress.toLowerCase() &&
                parsed.args[2] === nonce
              ) {
                if (parsed.args[3].toLowerCase() !== config.tokenAddress.toLowerCase()) {
                  continue;
                }
                const eventMinPrice = BigInt(parsed.args[4]);
                if (eventMinPrice < requiredPrice) {
                  res.status(400).json({
                    error: `Insufficient minPrice: committed ${eventMinPrice}, required ${requiredPrice}`,
                  });
                  return;
                }
                singleTxVerified = true;
                break;
              }
            } catch {
              // Event parsing expected to fail for non-matching logs
              continue;
            }
          }

          if (!singleTxVerified) {
            res.status(400).json({ error: "PayAndRecordCompleted event not found or mismatched" });
            return;
          }

          req.paymentInfo = {
            from: payerAddress,
            amount: String(config.price),
            asset: config.asset,
            recipient: config.recipientAddress,
            txHash,
            verifierTxHash: "",
            nonce,
            blockNumber: receipt.blockNumber,
          };

          res.setHeader("X-Payment-TxHash", txHash);
          safeOnPaymentVerified(config, {
            requestId,
            payer: payerAddress,
            nonce,
            amount: String(config.price),
            latencyMs: Date.now() - startTime,
          });
          fireWebhook(config, {
            event: "payment.verified",
            requestId,
            payer: payerAddress,
            nonce,
            amount: String(config.price),
            timestamp: new Date().toISOString(),
          });
          next();
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        safeOnPaymentFailed(config, { requestId, error: errMsg, latencyMs: Date.now() - startTime });
        if (err instanceof Error && err.message === "RPC timeout") {
          res.status(504).json({ error: "RPC timeout during payment verification" });
          return;
        }
        console.error("[fhe-x402] Batch verification failed:", err instanceof Error ? err.message : err);
        res.status(500).json({ error: "Payment verification failed" });
      }
    } finally {
      // [C2] Always release nonce mutex
      pendingBatchNonces.delete(nonce);
    }
  };
}
