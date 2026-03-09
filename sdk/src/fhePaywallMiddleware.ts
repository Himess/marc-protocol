import type { Request, Response, NextFunction, RequestHandler } from "express";
import { Contract, JsonRpcProvider, ethers } from "ethers";
import type {
  FhePaymentRequirements,
  FhePaymentPayload,
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

function checkRateLimit(ip: string, maxRequests: number = 60, windowMs: number = 60000): boolean {
  const now = Date.now();
  if (now - lastCleanup > windowMs) {
    for (const [key, entry] of rateLimitStore) {
      if (now > entry.resetAt) rateLimitStore.delete(key);
    }
    lastCleanup = now;
  }
  if (rateLimitStore.size >= MAX_RATE_LIMIT_ENTRIES) {
    const toDelete: string[] = [];
    for (const [key, entry] of rateLimitStore) {
      if (now > entry.resetAt) toDelete.push(key);
    }
    for (const key of toDelete) rateLimitStore.delete(key);
    if (rateLimitStore.size >= MAX_RATE_LIMIT_ENTRIES) return false;
  }
  const entry = rateLimitStore.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count++;
  return entry.count <= maxRequests;
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

const POOL_EVENT_ABI = [
  "event PaymentExecuted(address indexed from, address indexed to, uint64 minPrice, bytes32 nonce, bytes32 memo)",
];

/**
 * Express middleware that puts an FHE x402 paywall on a route.
 *
 * No Payment header → 402 with requirements.
 * Has Payment header → decode, verify PaymentExecuted event on-chain, call next().
 */
export function fhePaywall(config: FhePaywallConfig): RequestHandler {
  if (!ethers.isAddress(config.poolAddress)) {
    throw new Error(`Invalid pool address: ${config.poolAddress}`);
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
        poolAddress: config.poolAddress,
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

    // Nonce replay prevention — atomic check-and-add when supported
    if ("checkAndAdd" in nonceStore && typeof nonceStore.checkAndAdd === "function") {
      const isNew = await nonceStore.checkAndAdd(payload.nonce);
      if (!isNew) {
        res.status(400).json({ error: "Nonce already used" });
        return;
      }
    } else {
      const isNewNonce = await nonceStore.check(payload.nonce);
      if (!isNewNonce) {
        res.status(400).json({ error: "Nonce already used" });
        return;
      }
      await nonceStore.add(payload.nonce);
    }

    // ===== Verify on-chain event =====
    try {
      const receipt = await provider.getTransactionReceipt(payload.txHash);
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

      // Parse PaymentExecuted events from the receipt
      const iface = new ethers.Interface(POOL_EVENT_ABI);
      let verified = false;

      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== config.poolAddress.toLowerCase()) continue;
        try {
          const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
          if (
            parsed?.name === "PaymentExecuted" &&
            parsed.args[0].toLowerCase() === payload.from.toLowerCase() &&
            parsed.args[1].toLowerCase() === config.recipientAddress.toLowerCase() &&
            BigInt(parsed.args[2]) >= BigInt(config.price) && // FIX C-1: minPrice must be >= required price
            parsed.args[3] === payload.nonce
          ) {
            verified = true;
            break;
          }
        } catch {
          continue;
        }
      }

      if (!verified) {
        res.status(400).json({ error: "Payment event not found or mismatched" });
        return;
      }

      // Attach payment info
      req.paymentInfo = {
        from: payload.from,
        amount: String(config.price),
        asset: config.asset,
        recipient: config.recipientAddress,
        txHash: payload.txHash,
        nonce: payload.nonce,
        blockNumber: receipt.blockNumber,
      };

      res.setHeader("X-Payment-TxHash", payload.txHash);
      next();
    } catch (err) {
      console.error("[fhe-x402] Verification failed:", err instanceof Error ? err.message : err);
      res.status(500).json({ error: "Payment verification failed" });
    }
  };
}
