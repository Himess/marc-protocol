// SPDX-License-Identifier: BUSL-1.1

/**
 * @marc-protocol/mpp-method
 *
 * MPP-compatible payment method using FHE on Ethereum for one-time charges.
 *
 * Key differences from x402:
 * - Uses `WWW-Authenticate: Payment` header (not custom `Payment` header)
 * - Uses `Authorization: Payment <base64url-credential>` (not `Payment: base64...`)
 * - Challenge format follows the MPP IETF draft spec
 * - Settlement on Ethereum (not Tempo)
 * - EIP-712 typed-data signatures (not ethers.signMessage)
 * - RFC 8785 JSON canonicalization
 * - RFC 7807 problem details for errors
 * - base64url encoding without padding
 * - Challenge expiration (default 5 minutes)
 * - Challenge-credential binding
 * - Payment-Receipt header on success
 * - HMAC-bound challenge IDs
 */

import { Contract, JsonRpcProvider, ethers } from "ethers";
import { createHmac, createHash } from "crypto";
import type { Signer } from "ethers";

// ============================================================================
// Constants
// ============================================================================

export const FHE_SCHEME = "fhe-confidential-v1" as const;

/** Default challenge expiration: 5 minutes */
const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Default HMAC secret when none is provided */
const DEFAULT_HMAC_SECRET = "marc-mpp-default-secret";

// ============================================================================
// Types
// ============================================================================

export interface MarcMppConfig {
  tokenAddress: string;
  verifierAddress: string;
  recipientAddress: string;
  amount: string; // USDC (6 decimals)
  chainId: number;
  rpcUrl: string;
  realm?: string;
  /** HMAC secret for challenge ID binding. Use a strong secret in production. */
  hmacSecret?: string;
  /** Challenge TTL in milliseconds. Default: 5 minutes (300000) */
  challengeTtlMs?: number;
  /** Optional description for the challenge */
  description?: string;
}

export interface MppChallenge {
  id: string;
  realm: string;
  method: string;
  intent: "charge";
  request: string; // base64url-encoded requirements
  /** RFC 3339 timestamp when this challenge expires */
  expires?: string;
  /** Optional digest of the request payload */
  digest?: string;
  /** Optional human-readable description */
  description?: string;
  /** Optional opaque server data (round-tripped by client) */
  opaque?: string;
}

export interface MppVerifyResult {
  valid: boolean;
  txHash?: string;
  from?: string;
  amount?: string;
  error?: string;
  /** Payment receipt object (set on success) */
  receipt?: MppReceipt;
}

/** Decoded contents of MppChallenge.request */
export interface MppRequestPayload {
  scheme: typeof FHE_SCHEME;
  network: string;
  tokenAddress: string;
  verifierAddress: string;
  recipientAddress: string;
  amount: string;
}

/** Payment credential sent by client (base64url-encoded in Authorization header) */
export interface MppCredential {
  /** Echoed challenge fields for binding */
  challenge: {
    id: string;
    realm: string;
    method: string;
    intent: string;
  };
  /** Optional DID source identifier: "did:ethr:0x..." */
  source?: string;
  /** Payment payload */
  payload: {
    scheme: typeof FHE_SCHEME;
    txHash: string;
    verifierTxHash: string;
    nonce: string;
    from: string;
    chainId: number;
    signature: string;
  };
}

/** RFC 7807 Problem Details */
export interface ProblemDetails {
  type: string;
  title: string;
  detail: string;
  status: number;
  instance?: string;
}

/** Payment receipt returned in Payment-Receipt header */
export interface MppReceipt {
  status: "success" | "failed";
  method: typeof FHE_SCHEME;
  timestamp: string;
  reference: string;
  from?: string;
  amount?: string;
}

/** Minimal @zama-fhe/relayer-sdk interface */
export interface FhevmInstance {
  createEncryptedInput: (contractAddress: string, userAddress: string) => FhevmEncryptedInput;
}

export interface FhevmEncryptedInput {
  add64: (value: bigint | number) => void;
  addAddress: (value: string) => void;
  encrypt: () => Promise<{
    handles: string[];
    inputProof: string;
  }>;
}

/**
 * Interface for pluggable nonce stores (e.g. Redis-backed for production).
 */
export interface MppNonceStore {
  has(nonce: string): Promise<boolean>;
  add(nonce: string, ttlMs?: number): Promise<void>;
}

/**
 * Extended paywall config with rate limiting, external nonce store, and challenge store options.
 */
export interface MppPaywallConfig extends MarcMppConfig {
  /** HMAC secret for challenge ID binding (inherited, re-documented for clarity) */
  hmacSecret?: string;
  /** Challenge TTL in milliseconds. Default: 300_000 (5 min) */
  challengeTtlMs?: number;
  /** Maximum requests per minute per IP. Default: 30 */
  rateLimitPerMinute?: number;
  /** Optional external nonce store (e.g. Redis). If provided, replaces InMemoryNonceStore. */
  externalNonceStore?: MppNonceStore;
}

// ============================================================================
// EIP-712 Domain & Types
// ============================================================================

const EIP712_DOMAIN = {
  name: "MARC-MPP",
  version: "1",
} as const;

const EIP712_TYPES = {
  Credential: [
    { name: "scheme", type: "string" },
    { name: "txHash", type: "string" },
    { name: "verifierTxHash", type: "string" },
    { name: "nonce", type: "bytes32" },
    { name: "from", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "challengeId", type: "string" },
  ],
};

function getEip712Domain(chainId: number) {
  return {
    ...EIP712_DOMAIN,
    chainId,
  };
}

// ============================================================================
// ABIs (minimal)
// ============================================================================

const TOKEN_ABI = [
  "function confidentialTransfer(address to, bytes32 encryptedAmount, bytes calldata inputProof) external returns (bytes32)",
  "event ConfidentialTransfer(address indexed from, address indexed to, bytes32 indexed amount)",
];

const VERIFIER_ABI = [
  "function recordPayment(address server, bytes32 nonce, uint64 minPrice) external",
  "function usedNonces(bytes32 nonce) external view returns (bool)",
  "event PaymentVerified(address indexed payer, address indexed server, bytes32 indexed nonce, uint64 minPrice)",
];

// ============================================================================
// RFC 8785 JSON Canonicalization
// ============================================================================

/**
 * Produce a canonical JSON string per RFC 8785.
 *
 * - Object keys are sorted lexicographically.
 * - No whitespace is inserted.
 * - Primitives use standard JSON.stringify.
 */
export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJson).join(",") + "]";
  const record = obj as Record<string, unknown>;
  return (
    "{" +
    Object.keys(record)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(record[k]))
      .join(",") +
    "}"
  );
}

// ============================================================================
// base64url encoding (RFC 4648 Section 5, no padding)
// ============================================================================

/**
 * Encode an object as a base64url string (no padding).
 */
export function base64UrlEncode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/**
 * Decode a base64url string into a typed object.
 */
export function base64UrlDecode<T>(str: string): T {
  return JSON.parse(Buffer.from(str, "base64url").toString("utf-8")) as T;
}

// ============================================================================
// Legacy base64 helpers (kept for backward compatibility)
// ============================================================================

function base64Encode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

function base64Decode<T>(str: string): T {
  const json = Buffer.from(str, "base64").toString("utf-8");
  return JSON.parse(json) as T;
}

// ============================================================================
// Challenge ID HMAC Binding
// ============================================================================

/**
 * Create a deterministic challenge ID bound to the challenge parameters via HMAC.
 */
export function createChallengeId(params: Record<string, string>, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(canonicalJson(params));
  return hmac.digest("hex").slice(0, 32);
}

// ============================================================================
// EIP-712 Signature helpers
// ============================================================================

/**
 * Build the EIP-712 typed-data value object for a credential payload.
 */
function buildEip712Value(payload: Omit<MppCredential["payload"], "signature">, challengeId: string) {
  return {
    scheme: payload.scheme,
    txHash: payload.txHash,
    verifierTxHash: payload.verifierTxHash,
    nonce: payload.nonce,
    from: payload.from,
    chainId: BigInt(payload.chainId),
    challengeId,
  };
}

/**
 * Sign a credential payload using EIP-712 typed data.
 */
async function signCredential(
  signer: Signer,
  payload: Omit<MppCredential["payload"], "signature">,
  challengeId: string,
): Promise<string> {
  const domain = getEip712Domain(payload.chainId);
  const value = buildEip712Value(payload, challengeId);
  return signer.signTypedData(domain, EIP712_TYPES, value);
}

/**
 * Verify an EIP-712 credential signature.
 */
function verifyCredentialSignature(credential: MppCredential): boolean {
  if (!credential.payload.signature) return false;
  try {
    const domain = getEip712Domain(credential.payload.chainId);
    const value = buildEip712Value(credential.payload, credential.challenge.id);
    const recovered = ethers.verifyTypedData(domain, EIP712_TYPES, value, credential.payload.signature);
    return recovered.toLowerCase() === credential.payload.from.toLowerCase();
  } catch {
    return false;
  }
}

// ============================================================================
// Legacy signature helpers (backward compatibility)
// ============================================================================

/**
 * Create a canonical message from credential data (legacy, for backward compatibility).
 * Sorts keys, excludes "signature".
 */
function canonicalCredentialMessage(data: Record<string, unknown>): string {
  const sorted = Object.keys(data)
    .filter((k) => k !== "signature")
    .sort()
    .reduce((obj, key) => ({ ...obj, [key]: data[key] }), {});
  return JSON.stringify(sorted);
}

// ============================================================================
// Validation helpers
// ============================================================================

/**
 * Validate a USDC amount string (must be a non-negative integer, 6-decimal precision).
 */
export function validateAmount(amount: string): boolean {
  if (!/^\d+$/.test(amount)) return false;
  const n = BigInt(amount);
  return n >= 0n && n <= 1_000_000_000_000n; // Max ~1M USDC
}

/**
 * Validate an Ethereum address (checksum-aware via ethers.isAddress).
 */
export function validateAddress(address: string): boolean {
  return ethers.isAddress(address);
}

/**
 * Get the checksummed version of an address.
 */
export function checksumAddress(address: string): string {
  return ethers.getAddress(address);
}

// ============================================================================
// RFC 7807 Problem Details helpers
// ============================================================================

const PROBLEM_BASE = "https://marcprotocol.com/problems";

export function problemPaymentRequired(detail?: string): ProblemDetails {
  return {
    type: `${PROBLEM_BASE}/payment-required`,
    title: "Payment Required",
    detail: detail ?? "This resource requires an FHE-encrypted payment",
    status: 402,
  };
}

export function problemBadRequest(detail: string): ProblemDetails {
  return {
    type: `${PROBLEM_BASE}/bad-request`,
    title: "Bad Request",
    detail,
    status: 400,
  };
}

export function problemUnauthorized(detail: string): ProblemDetails {
  return {
    type: `${PROBLEM_BASE}/unauthorized`,
    title: "Unauthorized",
    detail,
    status: 401,
  };
}

export function problemChallengeExpired(): ProblemDetails {
  return {
    type: `${PROBLEM_BASE}/challenge-expired`,
    title: "Challenge Expired",
    detail: "The payment challenge has expired. Request a new one.",
    status: 402,
  };
}

export function problemTooManyRequests(): ProblemDetails {
  return {
    type: `${PROBLEM_BASE}/too-many-requests`,
    title: "Too Many Requests",
    detail: "Rate limit exceeded. Please try again later.",
    status: 429,
  };
}

export function problemChallengeReplay(): ProblemDetails {
  return {
    type: `${PROBLEM_BASE}/challenge-replay`,
    title: "Challenge Already Used",
    detail: "This payment challenge has already been consumed. Request a new one.",
    status: 400,
  };
}

export function problemUnknownChallenge(): ProblemDetails {
  return {
    type: `${PROBLEM_BASE}/unknown-challenge`,
    title: "Unknown Challenge",
    detail: "This challenge was not issued by this server.",
    status: 400,
  };
}

// ============================================================================
// Nonce store (in-memory)
// ============================================================================

class InMemoryNonceStore {
  private nonces = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(maxEntries: number = 100_000, ttlMs: number = 86_400_000) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  checkAndAdd(nonce: string): boolean {
    const expiry = this.nonces.get(nonce);
    if (expiry !== undefined && Date.now() <= expiry) {
      return false;
    }
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
    return true;
  }

  /**
   * Async adapter so InMemoryNonceStore can satisfy MppNonceStore interface usage.
   */
  async hasAsync(nonce: string): Promise<boolean> {
    const expiry = this.nonces.get(nonce);
    return expiry !== undefined && Date.now() <= expiry;
  }

  async addAsync(nonce: string, ttlMs?: number): Promise<void> {
    const ttl = ttlMs ?? this.ttlMs;
    this.nonces.set(nonce, Date.now() + ttl);
  }
}

// ============================================================================
// Challenge replay detection store
// ============================================================================

/**
 * In-memory challenge store for replay detection.
 *
 * Tracks issued challenges and prevents reuse of consumed challenge IDs.
 */
export class InMemoryChallengeStore {
  private challenges = new Map<string, { createdAt: number; consumed: boolean }>();

  /**
   * Issue a new challenge ID (mark it as known and unconsumed).
   */
  issue(id: string): void {
    this.challenges.set(id, { createdAt: Date.now(), consumed: false });
  }

  /**
   * Attempt to consume a challenge ID.
   * Returns true if the challenge was found and not yet consumed.
   * Returns false if unknown or already consumed.
   */
  consume(id: string): boolean {
    const entry = this.challenges.get(id);
    if (!entry || entry.consumed) return false;
    entry.consumed = true;
    return true;
  }

  /**
   * Check if a challenge ID was issued by this server (regardless of consumed state).
   */
  has(id: string): boolean {
    return this.challenges.has(id);
  }

  /**
   * Check if a challenge ID is valid (issued and not yet consumed).
   */
  isValid(id: string): boolean {
    const entry = this.challenges.get(id);
    return !!entry && !entry.consumed;
  }

  /**
   * Clean up challenges older than maxAgeMs (default 10 minutes).
   */
  cleanup(maxAgeMs: number = 600_000): void {
    const now = Date.now();
    for (const [id, entry] of this.challenges) {
      if (now - entry.createdAt > maxAgeMs) this.challenges.delete(id);
    }
  }
}

// ============================================================================
// Rate limiter (per-IP, sliding window)
// ============================================================================

/**
 * Simple per-IP rate limiter with 1-minute sliding windows.
 */
export class RateLimiter {
  private requests = new Map<string, { count: number; resetAt: number }>();

  /**
   * Check if the IP is within the rate limit.
   * Returns true if allowed, false if limit exceeded.
   * Automatically increments the counter for allowed requests.
   */
  check(ip: string, limit: number): boolean {
    const now = Date.now();
    const entry = this.requests.get(ip);
    if (!entry || now > entry.resetAt) {
      this.requests.set(ip, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count++;
    return true;
  }

  /**
   * Clean up expired entries to free memory.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [ip, entry] of this.requests) {
      if (now > entry.resetAt) this.requests.delete(ip);
    }
  }
}

// ============================================================================
// Receipt generation
// ============================================================================

/**
 * Create a payment receipt for the Payment-Receipt header.
 */
export function createMppReceipt(
  txHash: string,
  from?: string,
  amount?: string,
): MppReceipt {
  return {
    status: "success",
    method: FHE_SCHEME,
    timestamp: new Date().toISOString(),
    reference: txHash,
    from,
    amount,
  };
}

// ============================================================================
// Server-side: Create MPP challenge
// ============================================================================

/**
 * Generate an MPP-compatible 402 challenge with FHE payment option.
 *
 * The challenge follows the MPP IETF draft spec format, with `request`
 * containing a base64url-encoded payload describing the FHE payment requirements.
 * Challenge IDs are HMAC-bound to the challenge parameters.
 * Challenges expire after the configured TTL (default 5 minutes).
 *
 * Usage:
 * ```ts
 * const challenge = createMppChallenge({
 *   tokenAddress: "0xE944...",
 *   verifierAddress: "0x4503...",
 *   recipientAddress: "0xYourAddress",
 *   amount: "1000000", // 1 USDC
 *   chainId: 11155111,
 *   rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
 * });
 * res.status(402)
 *   .setHeader("WWW-Authenticate", formatMppChallenge(challenge))
 *   .json(problemPaymentRequired());
 * ```
 */
export function createMppChallenge(config: MarcMppConfig, requestBody?: unknown): MppChallenge {
  const requestPayload: MppRequestPayload = {
    scheme: FHE_SCHEME,
    network: `eip155:${config.chainId}`,
    tokenAddress: config.tokenAddress,
    verifierAddress: config.verifierAddress,
    recipientAddress: config.recipientAddress,
    amount: config.amount,
  };

  const realm = config.realm || "marc-protocol";
  const method = "fhe-confidential";
  const secret = config.hmacSecret || DEFAULT_HMAC_SECRET;
  const ttlMs = config.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;

  // Create HMAC-bound challenge ID
  const idParams: Record<string, string> = {
    realm,
    method,
    tokenAddress: config.tokenAddress,
    verifierAddress: config.verifierAddress,
    recipientAddress: config.recipientAddress,
    amount: config.amount,
    chainId: String(config.chainId),
    timestamp: Date.now().toString(),
    entropy: ethers.hexlify(ethers.randomBytes(16)),
  };
  const id = createChallengeId(idParams, secret);

  const expires = new Date(Date.now() + ttlMs).toISOString();

  const challenge: MppChallenge = {
    id,
    realm,
    method,
    intent: "charge",
    request: base64UrlEncode(requestPayload),
    expires,
  };

  // Feature 2: Digest parameter — SHA-256 hash of the request body
  if (requestBody !== undefined) {
    challenge.digest = createHash("sha256")
      .update(JSON.stringify(requestBody))
      .digest("hex");
  }

  if (config.description) {
    challenge.description = config.description;
  }

  return challenge;
}

/**
 * Format an MppChallenge into a WWW-Authenticate header value.
 *
 * Follows the MPP IETF draft format:
 * `Payment realm="marc-protocol", method="fhe-confidential", intent="charge", id="...", request="base64url...", expires="..."`
 */
export function formatMppChallenge(challenge: MppChallenge): string {
  const parts: string[] = [
    `Payment realm="${challenge.realm}"`,
    `method="${challenge.method}"`,
    `intent="${challenge.intent}"`,
    `id="${challenge.id}"`,
    `request="${challenge.request}"`,
  ];

  if (challenge.expires) {
    parts.push(`expires="${challenge.expires}"`);
  }
  if (challenge.digest) {
    parts.push(`digest="${challenge.digest}"`);
  }
  if (challenge.description) {
    parts.push(`description="${challenge.description}"`);
  }
  if (challenge.opaque) {
    parts.push(`opaque="${challenge.opaque}"`);
  }

  return parts.join(", ");
}

/**
 * Parse a WWW-Authenticate header value into an MppChallenge.
 *
 * Extracts realm, method, intent, id, request, and optional fields
 * (expires, digest, description, opaque) from the header.
 */
export function parseMppChallenge(header: string): MppChallenge | null {
  if (!header.startsWith("Payment ")) return null;

  const params = header.slice("Payment ".length);

  function extractParam(name: string): string | null {
    const regex = new RegExp(`${name}="([^"]*)"`, "i");
    const match = params.match(regex);
    return match ? match[1] : null;
  }

  const realm = extractParam("realm");
  const method = extractParam("method");
  const intent = extractParam("intent");
  const id = extractParam("id");
  const request = extractParam("request");

  if (!realm || !method || !intent || !id || !request) return null;
  if (intent !== "charge") return null;

  const challenge: MppChallenge = { id, realm, method, intent, request };

  // Optional fields
  const expires = extractParam("expires");
  if (expires) challenge.expires = expires;

  const digest = extractParam("digest");
  if (digest) challenge.digest = digest;

  const description = extractParam("description");
  if (description) challenge.description = description;

  const opaque = extractParam("opaque");
  if (opaque) challenge.opaque = opaque;

  return challenge;
}

/**
 * Decode the request field of an MppChallenge into its typed payload.
 * Supports both base64url and legacy base64 encoding.
 */
export function decodeMppRequest(challenge: MppChallenge): MppRequestPayload {
  try {
    return base64UrlDecode<MppRequestPayload>(challenge.request);
  } catch {
    // Fall back to legacy base64 for backward compatibility
    return base64Decode<MppRequestPayload>(challenge.request);
  }
}

// ============================================================================
// Server-side: Verify MPP credential
// ============================================================================

/**
 * Check if a challenge has expired.
 */
export function isChallengeExpired(challenge: MppChallenge): boolean {
  if (!challenge.expires) return false;
  const expiresAt = new Date(challenge.expires).getTime();
  if (isNaN(expiresAt)) return false;
  return Date.now() > expiresAt;
}

/**
 * Verify an MPP credential (FHE payment proof).
 *
 * Steps:
 * 1. Decode base64url credential into MppCredential
 * 2. Validate challenge binding
 * 3. Verify EIP-712 signature
 * 4. Verify on-chain events (ConfidentialTransfer + PaymentVerified)
 * 5. Return verification result with receipt
 *
 * Usage:
 * ```ts
 * const authHeader = req.headers.authorization;
 * const credential = authHeader.slice("Payment ".length);
 * const result = await verifyMppCredential(credential, config);
 * if (!result.valid) {
 *   res.status(401).json(problemUnauthorized(result.error!));
 * }
 * ```
 */
export async function verifyMppCredential(
  credential: string,
  config: MarcMppConfig,
  /** Optional: the original challenge for binding and expiry validation */
  challenge?: MppChallenge,
  /** Optional: the original request body for digest verification */
  requestBody?: unknown,
): Promise<MppVerifyResult> {
  // Decode credential (try base64url first, then legacy base64)
  let cred: MppCredential;
  try {
    cred = base64UrlDecode<MppCredential>(credential);
  } catch {
    try {
      cred = base64Decode<MppCredential>(credential);
    } catch {
      return { valid: false, error: "Invalid credential encoding" };
    }
  }

  // Handle legacy flat credentials (no .payload wrapper) for backward compatibility
  const payload = cred.payload ?? (cred as unknown as MppCredential["payload"]);
  const challengeEcho = cred.challenge;

  // Validate scheme
  if (payload.scheme !== FHE_SCHEME) {
    return { valid: false, error: `Unsupported scheme: ${payload.scheme}` };
  }

  // Validate required fields
  if (!payload.txHash || !payload.nonce || !payload.from || !payload.signature) {
    return { valid: false, error: "Missing required credential fields" };
  }

  // Validate chain ID
  if (payload.chainId !== config.chainId) {
    return {
      valid: false,
      error: `Chain ID mismatch: expected ${config.chainId}, got ${payload.chainId}`,
    };
  }

  // Validate nonce format
  if (!/^0x[0-9a-fA-F]{64}$/.test(payload.nonce)) {
    return { valid: false, error: "Invalid nonce format" };
  }

  // Validate address checksum
  if (!validateAddress(payload.from)) {
    return { valid: false, error: "Invalid sender address" };
  }

  // Validate challenge binding (if present on both sides)
  if (challenge && challengeEcho) {
    if (challengeEcho.id !== challenge.id) {
      return { valid: false, error: "Challenge ID mismatch" };
    }
    if (challengeEcho.realm !== challenge.realm) {
      return { valid: false, error: "Challenge realm mismatch" };
    }
    if (challengeEcho.method !== challenge.method) {
      return { valid: false, error: "Challenge method mismatch" };
    }

    // Validate challenge expiration
    if (isChallengeExpired(challenge)) {
      return { valid: false, error: "Challenge has expired" };
    }

    // Feature 2: Validate digest if challenge has one
    if (challenge.digest && requestBody !== undefined) {
      const expectedDigest = createHash("sha256")
        .update(JSON.stringify(requestBody))
        .digest("hex");
      if (challenge.digest !== expectedDigest) {
        return { valid: false, error: "Digest mismatch: request body has been tampered with" };
      }
    }
  }

  // Verify EIP-712 signature
  if (!verifyCredentialSignature(cred)) {
    return { valid: false, error: "Invalid credential signature" };
  }

  // Verify on-chain events
  const provider = new JsonRpcProvider(config.rpcUrl);

  try {
    // Verify ConfidentialTransfer event
    const receipt = await provider.getTransactionReceipt(payload.txHash);
    if (!receipt || receipt.status === 0) {
      return { valid: false, error: "Transfer transaction failed or not found" };
    }

    const tokenIface = new ethers.Interface(TOKEN_ABI);
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
        continue;
      }
    }

    if (!transferVerified) {
      return { valid: false, error: "ConfidentialTransfer event not found or mismatched" };
    }

    // Verify PaymentVerified event (if dual-TX flow)
    if (payload.verifierTxHash) {
      const vReceipt = await provider.getTransactionReceipt(payload.verifierTxHash);
      if (!vReceipt || vReceipt.status === 0) {
        return { valid: false, error: "Verifier transaction failed or not found" };
      }

      const verifierIface = new ethers.Interface(VERIFIER_ABI);
      let nonceVerified = false;
      const requiredAmount = BigInt(config.amount);

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
            const eventMinPrice = BigInt(parsed.args[3]);
            if (eventMinPrice < requiredAmount) {
              return {
                valid: false,
                error: `Insufficient payment: committed ${eventMinPrice}, required ${requiredAmount}`,
              };
            }
            nonceVerified = true;
            break;
          }
        } catch {
          continue;
        }
      }

      if (!nonceVerified) {
        return { valid: false, error: "PaymentVerified event not found or mismatched" };
      }
    }

    const mppReceipt = createMppReceipt(payload.txHash, payload.from, config.amount);

    return {
      valid: true,
      txHash: payload.txHash,
      from: payload.from,
      amount: config.amount,
      receipt: mppReceipt,
    };
  } catch (err) {
    return {
      valid: false,
      error: `On-chain verification failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ============================================================================
// Client-side: Handle MPP 402 response with FHE payment
// ============================================================================

/**
 * Handle an MPP 402 response by making an FHE payment on Ethereum.
 *
 * Steps:
 * 1. Parse WWW-Authenticate header
 * 2. Extract FHE payment requirements from challenge
 * 3. Encrypt amount, transfer cUSDC, record nonce
 * 4. Sign with EIP-712 typed data
 * 5. Return base64url credential for Authorization header
 *
 * Usage:
 * ```ts
 * const response = await fetch("https://api.example.com/premium");
 * if (response.status === 402) {
 *   const { credential, txHash } = await handleMpp402(response, signer, fhevmInstance);
 *   const retryResponse = await fetch("https://api.example.com/premium", {
 *     headers: { Authorization: `Payment ${credential}` },
 *   });
 * }
 * ```
 */
export async function handleMpp402(
  response: Response,
  signer: Signer,
  fhevmInstance: FhevmInstance,
): Promise<{ credential: string; txHash: string }> {
  if (response.status !== 402) {
    throw new Error(`Expected 402 response, got ${response.status}`);
  }

  // Parse WWW-Authenticate header
  const wwwAuth = response.headers.get("www-authenticate");
  if (!wwwAuth) {
    throw new Error("Missing WWW-Authenticate header in 402 response");
  }

  const challenge = parseMppChallenge(wwwAuth);
  if (!challenge) {
    throw new Error("Failed to parse MPP challenge from WWW-Authenticate header");
  }

  if (challenge.method !== "fhe-confidential") {
    throw new Error(`Unsupported payment method: ${challenge.method}`);
  }

  // Check if challenge has expired
  if (isChallengeExpired(challenge)) {
    throw new Error("Challenge has expired");
  }

  // Decode request payload
  const requestPayload = decodeMppRequest(challenge);
  if (requestPayload.scheme !== FHE_SCHEME) {
    throw new Error(`Unsupported scheme in challenge: ${requestPayload.scheme}`);
  }

  const signerAddress = await signer.getAddress();
  const amount = BigInt(requestPayload.amount);
  const nonce = ethers.hexlify(ethers.randomBytes(32));

  // Parse chainId from network (eip155:XXXXX)
  const chainIdStr = requestPayload.network.split(":")[1];
  if (!chainIdStr) {
    throw new Error(`Invalid network format: ${requestPayload.network}`);
  }
  const chainId = parseInt(chainIdStr, 10);

  // Encrypt amount
  const input = fhevmInstance.createEncryptedInput(requestPayload.tokenAddress, signerAddress);
  input.add64(amount);
  const encrypted = await input.encrypt();

  if (!encrypted.handles || encrypted.handles.length === 0) {
    throw new Error("FHE encryption returned no handles");
  }

  // Step 1: confidentialTransfer
  const token = new Contract(requestPayload.tokenAddress, TOKEN_ABI, signer);
  const tx = await token.confidentialTransfer(
    requestPayload.recipientAddress,
    encrypted.handles[0],
    encrypted.inputProof,
  );
  const receipt = await tx.wait();

  if (!receipt || receipt.status === 0) {
    throw new Error(`Payment transaction failed: ${tx.hash}`);
  }

  // Step 2: recordPayment
  const verifier = new Contract(requestPayload.verifierAddress, VERIFIER_ABI, signer);
  const vTx = await verifier.recordPayment(requestPayload.recipientAddress, nonce, amount);
  const vReceipt = await vTx.wait();

  if (!vReceipt || vReceipt.status === 0) {
    throw new Error(`Verifier recordPayment failed. Transfer succeeded: ${tx.hash}`);
  }

  // Build credential with challenge binding
  const payloadData: Omit<MppCredential["payload"], "signature"> = {
    scheme: FHE_SCHEME,
    txHash: tx.hash,
    verifierTxHash: vTx.hash,
    nonce,
    from: signerAddress,
    chainId,
  };

  // Sign with EIP-712
  const signature = await signCredential(signer, payloadData, challenge.id);

  const cred: MppCredential = {
    challenge: {
      id: challenge.id,
      realm: challenge.realm,
      method: challenge.method,
      intent: challenge.intent,
    },
    source: `did:ethr:${signerAddress}`,
    payload: {
      ...payloadData,
      signature,
    },
  };

  return {
    credential: base64UrlEncode(cred),
    txHash: tx.hash,
  };
}

// ============================================================================
// Express middleware: MPP paywall with FHE
// ============================================================================

/**
 * Express middleware that creates an MPP-compatible paywall using FHE payments.
 *
 * Follows the MPP IETF draft spec:
 * - No Authorization header with "Payment" scheme: returns 402 with WWW-Authenticate header
 * - `Authorization: Payment <base64url-credential>`: verifies the FHE payment credential
 * - Sets `Payment-Receipt` header on successful verification
 * - Returns RFC 7807 problem details for errors
 *
 * Usage:
 * ```ts
 * import { mppFhePaywall } from "@marc-protocol/mpp-method";
 *
 * app.use("/api/premium", mppFhePaywall({
 *   tokenAddress: "0xE944...",
 *   verifierAddress: "0x4503...",
 *   recipientAddress: "0xYourAddress",
 *   amount: "1000000", // 1 USDC
 *   chainId: 11155111,
 *   rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
 * }));
 * ```
 */
export function mppFhePaywall(config: MarcMppConfig | MppPaywallConfig) {
  if (!validateAddress(config.tokenAddress)) {
    throw new Error(`Invalid token address: ${config.tokenAddress}`);
  }
  if (!validateAddress(config.verifierAddress)) {
    throw new Error(`Invalid verifier address: ${config.verifierAddress}`);
  }
  if (!validateAddress(config.recipientAddress)) {
    throw new Error(`Invalid recipient address: ${config.recipientAddress}`);
  }
  if (!validateAmount(config.amount)) {
    throw new Error(`Invalid amount: ${config.amount}`);
  }

  // Feature 4: Use external nonce store if provided, otherwise in-memory
  const paywallConfig = config as MppPaywallConfig;
  const externalNonceStore = paywallConfig.externalNonceStore;
  const inMemoryNonceStore = externalNonceStore ? null : new InMemoryNonceStore();

  // Feature 3: Challenge replay detection store
  const challengeStore = new InMemoryChallengeStore();

  // Store active challenges for binding validation (kept for backward compat)
  const activeChallenges = new Map<string, MppChallenge>();

  // Feature 5: Rate limiter
  const rateLimitPerMinute = paywallConfig.rateLimitPerMinute ?? 30;
  const rateLimiter = new RateLimiter();

  return async (
    req: { method: string; headers: Record<string, string | undefined>; ip?: string; connection?: { remoteAddress?: string } },
    res: {
      status: (code: number) => any;
      json: (body: unknown) => void;
      setHeader: (key: string, value: string) => void;
    },
    next: () => void,
  ) => {
    // Feature 5: Rate limiting per IP
    const ip = req.ip || req.connection?.remoteAddress || req.headers["x-forwarded-for"] || "unknown";
    if (!rateLimiter.check(ip, rateLimitPerMinute)) {
      res.setHeader("Retry-After", "60");
      res.status(429).json(problemTooManyRequests());
      return;
    }

    const authHeader = req.headers["authorization"];

    // No Authorization header with Payment scheme -> return 402
    if (!authHeader || !authHeader.startsWith("Payment ")) {
      const challenge = createMppChallenge(config);

      // Feature 3: Register challenge in the challenge store
      challengeStore.issue(challenge.id);

      // Store challenge for later binding validation
      activeChallenges.set(challenge.id, challenge);

      // Clean up expired challenges
      for (const [cid, ch] of activeChallenges) {
        if (isChallengeExpired(ch)) activeChallenges.delete(cid);
      }
      challengeStore.cleanup();

      const wwwAuth = formatMppChallenge(challenge);

      res.setHeader("WWW-Authenticate", wwwAuth);
      res.status(402).json(problemPaymentRequired());
      return;
    }

    // Extract credential from Authorization header
    // Format: Authorization: Payment <base64url-credential>
    const credential = authHeader.slice("Payment ".length).trim();

    if (!credential) {
      res.status(400).json(problemBadRequest("Missing credential in Authorization header"));
      return;
    }

    // Size check
    if (credential.length > 100 * 1024) {
      res.status(400).json(problemBadRequest("Credential too large"));
      return;
    }

    // Decode credential for nonce check
    let cred: MppCredential;
    try {
      cred = base64UrlDecode<MppCredential>(credential);
    } catch {
      try {
        cred = base64Decode<MppCredential>(credential);
      } catch {
        res.status(400).json(problemBadRequest("Invalid credential encoding"));
        return;
      }
    }

    // Handle legacy flat credentials
    const payload = cred.payload ?? (cred as unknown as MppCredential["payload"]);

    // Nonce format validation (basic input validation first)
    if (!payload.nonce || !/^0x[0-9a-fA-F]{64}$/.test(payload.nonce)) {
      res.status(400).json(problemBadRequest("Invalid nonce format"));
      return;
    }

    // Feature 3: Validate challenge was issued by this server and not yet consumed
    if (cred.challenge?.id) {
      if (!challengeStore.has(cred.challenge.id)) {
        res.status(400).json(problemUnknownChallenge());
        return;
      }
      if (!challengeStore.isValid(cred.challenge.id)) {
        res.status(400).json(problemChallengeReplay());
        return;
      }
    }

    // Feature 4: Nonce replay prevention (external or in-memory)
    if (externalNonceStore) {
      const alreadyUsed = await externalNonceStore.has(payload.nonce);
      if (alreadyUsed) {
        res.status(400).json(problemBadRequest("Nonce already used"));
        return;
      }
      await externalNonceStore.add(payload.nonce);
    } else if (inMemoryNonceStore) {
      if (!inMemoryNonceStore.checkAndAdd(payload.nonce)) {
        res.status(400).json(problemBadRequest("Nonce already used"));
        return;
      }
    }

    // Look up the original challenge for binding validation
    const originalChallenge = cred.challenge?.id
      ? activeChallenges.get(cred.challenge.id)
      : undefined;

    // If we have a challenge echo, validate binding and expiry
    if (originalChallenge && isChallengeExpired(originalChallenge)) {
      activeChallenges.delete(originalChallenge.id);
      res.status(402).json(problemChallengeExpired());
      return;
    }

    // Verify credential
    const result = await verifyMppCredential(credential, config, originalChallenge);

    if (!result.valid) {
      res.status(401).json(problemUnauthorized(result.error ?? "Invalid payment"));
      return;
    }

    // Feature 3: Mark challenge as consumed after successful verification
    if (cred.challenge?.id) {
      challengeStore.consume(cred.challenge.id);
    }

    // Clean up used challenge from active map
    if (cred.challenge?.id) {
      activeChallenges.delete(cred.challenge.id);
    }

    // Set Payment-Receipt header
    if (result.receipt) {
      res.setHeader("Payment-Receipt", base64UrlEncode(result.receipt));
    }

    res.setHeader("X-Payment-TxHash", result.txHash ?? "");
    res.setHeader("X-Payment-From", result.from ?? "");
    next();
  };
}

// ============================================================================
// Client-side: createMppFetch
// ============================================================================

/**
 * Creates an MPP-aware fetch function that automatically handles 402 responses
 * by making FHE payments and retrying with `Authorization: Payment <credential>`.
 *
 * Usage:
 * ```ts
 * const mppFetch = createMppFetch(signer, fhevmInstance);
 * const response = await mppFetch("https://api.example.com/premium");
 * // If 402, automatically pays and retries
 * ```
 */
export function createMppFetch(
  signer: Signer,
  fhevmInstance: FhevmInstance,
  options?: { timeoutMs?: number },
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? 30_000;

  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const response = await fetchWithTimeout(url, init ?? {}, timeoutMs);

    if (response.status !== 402) return response;

    // Check for WWW-Authenticate: Payment header
    const wwwAuth = response.headers.get("www-authenticate");
    if (!wwwAuth || !wwwAuth.startsWith("Payment ")) return response;

    // Handle the 402 with FHE payment
    const { credential } = await handleMpp402(response, signer, fhevmInstance);

    // Retry with Authorization header (correct format: Payment <credential>)
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set("Authorization", `Payment ${credential}`);

    return fetchWithTimeout(url, { ...init, headers: retryHeaders }, timeoutMs);
  };
}

// ============================================================================
// Helpers
// ============================================================================

function generateChallengeId(): string {
  // UUID v4-like using crypto-safe random bytes
  const bytes = ethers.randomBytes(16);
  const hex = ethers.hexlify(bytes).slice(2);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "4" + hex.slice(13, 16),
    ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}

async function fetchWithTimeout(url: string | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  if (timeoutMs <= 0) return fetch(url, init);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// Re-exports for direct use
// ============================================================================

export {
  base64Encode,
  base64Decode,
  canonicalCredentialMessage,
  verifyCredentialSignature,
  generateChallengeId,
  InMemoryNonceStore,
};
