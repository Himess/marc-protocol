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

// ============================================================================
// Rate limiter
// ============================================================================

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore: Map<string, RateLimitEntry> = new Map();
let lastCleanup = Date.now();
const MAX_RATE_LIMIT_ENTRIES = 10_000;

function checkRateLimit(ip: string, maxRate: number = 60, windowMs: number = 60000): boolean {
  const now = Date.now();

  // Evict expired entries periodically
  if (now - lastCleanup > windowMs) {
    for (const [key, entry] of rateLimitStore) {
      if (now > entry.resetAt) {
        rateLimitStore.delete(key);
      }
    }
    // LRU eviction if still over capacity
    if (rateLimitStore.size > MAX_RATE_LIMIT_ENTRIES) {
      const entriesToDelete = rateLimitStore.size - MAX_RATE_LIMIT_ENTRIES;
      let deleted = 0;
      for (const key of rateLimitStore.keys()) {
        if (deleted >= entriesToDelete) break;
        rateLimitStore.delete(key);
        deleted++;
      }
    }
    lastCleanup = now;
  }

  const entry = rateLimitStore.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count++;
  return entry.count <= maxRate;
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

  check(nonce: string): boolean {
    const expiry = this.nonces.get(nonce);
    if (expiry === undefined) return true;
    // Expired nonce — treat as new
    if (Date.now() > expiry) {
      this.nonces.delete(nonce);
      return true;
    }
    return false;
  }

  add(nonce: string): void {
    // Evict expired entries if at capacity
    if (this.nonces.size >= this.maxEntries) {
      const now = Date.now();
      for (const [key, expiry] of this.nonces) {
        if (now > expiry) this.nonces.delete(key);
      }
      // If still at capacity, evict oldest
      if (this.nonces.size >= this.maxEntries) {
        const first = this.nonces.keys().next().value;
        if (first) this.nonces.delete(first);
      }
    }
    this.nonces.set(nonce, Date.now() + this.ttlMs);
  }

  /** Atomic check-and-add: returns true if nonce is new, false if replay. */
  checkAndAdd(nonce: string): boolean {
    if (!this.check(nonce)) return false;
    this.add(nonce);
    return true;
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

/** In-memory batch credit tracker. Key: `${payer}:${nonce}` */
const batchCreditStore: Map<string, BatchCredit> = new Map();
const MAX_BATCH_CREDITS = 50_000;
const BATCH_CREDIT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function batchCreditKey(payer: string, nonce: string): string {
  return `${payer.toLowerCase()}:${nonce}`;
}

function cleanExpiredBatchCredits(): void {
  const now = Date.now();
  for (const [key, credit] of batchCreditStore) {
    if (now - credit.createdAt > BATCH_CREDIT_TTL_MS) {
      batchCreditStore.delete(key);
    }
  }
}

/**
 * Try to consume one credit from a batch. Returns true if credit consumed.
 */
function consumeBatchCredit(payer: string, nonce: string): boolean {
  const key = batchCreditKey(payer, nonce);
  const credit = batchCreditStore.get(key);
  if (!credit || credit.remaining <= 0) return false;
  credit.remaining--;
  if (credit.remaining === 0) batchCreditStore.delete(key);
  return true;
}

/**
 * Register batch credits after verifying a BatchPaymentRecorded event.
 */
function registerBatchCredits(
  payer: string,
  server: string,
  nonce: string,
  requestCount: number,
  pricePerRequest: bigint
): void {
  const key = batchCreditKey(payer, nonce);
  // Prevent concurrent registration from overwriting existing credits
  if (batchCreditStore.has(key)) return;

  if (batchCreditStore.size >= MAX_BATCH_CREDITS) {
    cleanExpiredBatchCredits();
  }
  batchCreditStore.set(key, {
    remaining: requestCount,
    pricePerRequest,
    payer: payer.toLowerCase(),
    server: server.toLowerCase(),
    createdAt: Date.now(),
  });
}

/**
 * Get remaining credits for a payer+nonce pair.
 */
export function getBatchCredits(payer: string, nonce: string): number {
  const key = batchCreditKey(payer, nonce);
  return batchCreditStore.get(key)?.remaining ?? 0;
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
  const provider = new JsonRpcProvider(config.rpcUrl);
  const nonceStore: NonceStore = config.nonceStore ?? new InMemoryNonceStore();

  // [C2] Nonce mutex — prevent race condition where two concurrent requests
  // use the same nonce before either's on-chain verification completes.
  // Ported from PrivAgent middlewareV2.ts pendingNullifiers pattern.
  const pendingNonces = new Set<string>();

  return async (req: Request, res: Response, next: NextFunction) => {
    // Rate limiting — use socket address to prevent X-Forwarded-For spoofing
    const clientIp = req.socket?.remoteAddress ?? "unknown";
    if (!checkRateLimit(clientIp, maxRate, rateWindow)) {
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
      res.status(400).json({ error: "Payment header too large" });
      return;
    }

    let payload: FhePaymentPayload;
    try {
      const json = Buffer.from(paymentHeader, "base64").toString("utf-8");
      payload = JSON.parse(json) as FhePaymentPayload;
    } catch {
      res.status(400).json({ error: "Invalid Payment header encoding" });
      return;
    }

    // Validate structure
    if (payload.scheme !== FHE_SCHEME) {
      res.status(400).json({ error: "Unsupported payment scheme" });
      return;
    }
    if (!payload.txHash || !payload.nonce || !payload.from) {
      res.status(400).json({ error: "Missing required payment fields" });
      return;
    }

    // Chain ID verification — reject payments from wrong chain
    if (payload.chainId !== chainId) {
      res.status(400).json({ error: `Chain ID mismatch: expected ${chainId}, got ${payload.chainId}` });
      return;
    }

    // [C2] Nonce mutex — reject if another request is already processing this nonce
    if (pendingNonces.has(payload.nonce)) {
      res.status(409).json({ error: "Payment already being processed" });
      return;
    }
    pendingNonces.add(payload.nonce);

    try {
      // Nonce replay prevention — always atomic check-and-add to prevent TOCTOU race
      if ("checkAndAdd" in nonceStore && typeof nonceStore.checkAndAdd === "function") {
        const isNew = await nonceStore.checkAndAdd(payload.nonce);
        if (!isNew) {
          pendingNonces.delete(payload.nonce);
          res.status(400).json({ error: "Nonce already used" });
          return;
        }
      } else {
        // Fallback: use atomic check-and-add pattern even with separate methods
        const isNewNonce = await nonceStore.check(payload.nonce);
        if (!isNewNonce) {
          pendingNonces.delete(payload.nonce);
          res.status(400).json({ error: "Nonce already used" });
          return;
        }
        // Add immediately before any async work to minimize TOCTOU window
        await nonceStore.add(payload.nonce);
      }

      // ===== Verify on-chain events =====
      try {
        // Verify ConfidentialTransfer event (from cUSDC token)
        const receipt = await Promise.race([
          provider.getTransactionReceipt(payload.txHash),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), 30_000)),
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

        // Parse ConfidentialTransfer event
        const tokenIface = new ethers.Interface(TOKEN_EVENT_ABI);
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
            new Promise<null>((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), 30_000)),
          ]);
          if (!vReceipt || vReceipt.status === 0) {
            res.status(400).json({ error: "Verifier transaction failed or not found" });
            return;
          }

          const verifierIface = new ethers.Interface(VERIFIER_EVENT_ABI);
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
          // V4.2 single-TX: PayAndRecordCompleted in same receipt as ConfidentialTransfer
          const payAndRecordIface = new ethers.Interface(PAY_AND_RECORD_EVENT_ABI);
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
        next();
      } catch (err) {
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
  const rateWindow = config.rateLimitWindowMs ?? 60000;
  const minConfirmations = config.minConfirmations ?? 1;
  const provider = new JsonRpcProvider(config.rpcUrl);
  const nonceStore: NonceStore = config.nonceStore ?? new InMemoryNonceStore();

  // [C2] Nonce mutex — prevent race condition where two concurrent batch requests
  // use the same nonce before either's on-chain verification completes.
  // Ported from PrivAgent middlewareV2.ts pendingNullifiers pattern.
  const pendingBatchNonces = new Set<string>();

  return async (req: Request, res: Response, next: NextFunction) => {
    // Rate limiting
    const clientIp = req.socket?.remoteAddress ?? "unknown";
    if (!checkRateLimit(clientIp, maxRate, rateWindow)) {
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
      res.status(400).json({ error: "Payment header too large" });
      return;
    }

    let rawPayload: Record<string, unknown>;
    try {
      const json = Buffer.from(paymentHeader, "base64").toString("utf-8");
      rawPayload = JSON.parse(json) as Record<string, unknown>;
    } catch {
      res.status(400).json({ error: "Invalid Payment header encoding" });
      return;
    }

    if (rawPayload.scheme !== FHE_SCHEME) {
      res.status(400).json({ error: "Unsupported payment scheme" });
      return;
    }
    if (!rawPayload.txHash || !rawPayload.nonce || !rawPayload.from) {
      res.status(400).json({ error: "Missing required payment fields" });
      return;
    }
    if (rawPayload.chainId !== chainId) {
      res.status(400).json({ error: `Chain ID mismatch: expected ${chainId}, got ${rawPayload.chainId}` });
      return;
    }

    if (typeof rawPayload.from !== "string" || typeof rawPayload.nonce !== "string") {
      res.status(400).json({ error: "Invalid payment payload: from and nonce must be strings" });
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
        const key = batchCreditKey(payerAddress, nonce);
        const creditEntry = batchCreditStore.get(key);
        if (creditEntry && creditEntry.remaining > 0) {
          // Verify this nonce was previously registered (not a forged credit claim)
          // by checking that the batch credit store has a valid entry for this payer+nonce.
          // The nonce was already added to nonceStore during initial batch registration.
          const hasCredit = consumeBatchCredit(payerAddress, nonce);
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
            res.setHeader("X-Batch-Credits-Remaining", String(getBatchCredits(payerAddress, nonce)));
            next();
            return;
          }
        }
      }

      // ===== Nonce replay prevention — always atomic to prevent TOCTOU race =====
      if ("checkAndAdd" in nonceStore && typeof nonceStore.checkAndAdd === "function") {
        const isNew = await nonceStore.checkAndAdd(nonce);
        if (!isNew) {
          // For batch: nonce already used but no credits left → 402
          if (isBatch) {
            res.status(402).json({ error: "Batch credits exhausted", nonce });
            return;
          }
          res.status(400).json({ error: "Nonce already used" });
          return;
        }
      } else {
        // Fallback: use atomic check-and-add pattern even with separate methods
        const isNewNonce = await nonceStore.check(nonce);
        if (!isNewNonce) {
          if (isBatch) {
            res.status(402).json({ error: "Batch credits exhausted", nonce });
            return;
          }
          res.status(400).json({ error: "Nonce already used" });
          return;
        }
        // Add immediately before any async work to minimize TOCTOU window
        await nonceStore.add(nonce);
      }

      // ===== Verify on-chain events =====
      try {
        const txHash = rawPayload.txHash as string;
        const receipt = await Promise.race([
          provider.getTransactionReceipt(txHash),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), 30_000)),
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

        // Verify ConfidentialTransfer event
        const tokenIface = new ethers.Interface(TOKEN_EVENT_ABI);
        let transferVerified = false;

        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== config.tokenAddress.toLowerCase()) continue;
          try {
            const parsed = tokenIface.parseLog({ topics: log.topics as string[], data: log.data });
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
            new Promise<null>((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), 30_000)),
          ]);
          if (!vReceipt || vReceipt.status === 0) {
            res.status(400).json({ error: "Verifier transaction failed or not found" });
            return;
          }

          const batchIface = new ethers.Interface(BATCH_VERIFIER_EVENT_ABI);
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
              const parsed = batchIface.parseLog({ topics: log.topics as string[], data: log.data });
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

                // Register credits (minus 1 for this request)
                registerBatchCredits(
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
          res.setHeader("X-Batch-Credits-Remaining", String(getBatchCredits(payerAddress, nonce)));
          next();
        } else if (verifierTxHash) {
          // V4.0/V4.1: Verify PaymentVerified event (single payment)
          const vReceipt = await Promise.race([
            provider.getTransactionReceipt(verifierTxHash),
            new Promise<null>((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), 30_000)),
          ]);
          if (!vReceipt || vReceipt.status === 0) {
            res.status(400).json({ error: "Verifier transaction failed or not found" });
            return;
          }

          const verifierIface = new ethers.Interface(VERIFIER_EVENT_ABI);
          let nonceVerified = false;
          const requiredPrice = BigInt(config.price);

          for (const log of vReceipt.logs) {
            if (log.address.toLowerCase() !== config.verifierAddress.toLowerCase()) continue;
            try {
              const parsed = verifierIface.parseLog({ topics: log.topics as string[], data: log.data });
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
          next();
        } else {
          // V4.2 single-TX: PayAndRecordCompleted in same receipt as ConfidentialTransfer
          const payAndRecordIface = new ethers.Interface(PAY_AND_RECORD_EVENT_ABI);
          let singleTxVerified = false;
          const requiredPrice = BigInt(config.price);

          for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== config.verifierAddress.toLowerCase()) continue;
            try {
              const parsed = payAndRecordIface.parseLog({ topics: log.topics as string[], data: log.data });
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
          next();
        }
      } catch (err) {
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
