// SPDX-License-Identifier: BUSL-1.1

/**
 * @marc-protocol/mpp-method
 *
 * MPP-compatible payment method using FHE on Ethereum for one-time charges.
 *
 * Key differences from x402:
 * - Uses `WWW-Authenticate: Payment` header (not custom `Payment` header)
 * - Uses `Authorization: Payment credential="..."` (not `Payment: base64...`)
 * - Challenge format follows the MPP IETF draft spec
 * - Settlement on Ethereum (not Tempo)
 */

import { Contract, JsonRpcProvider, ethers } from "ethers";
import type { Signer } from "ethers";

// ============================================================================
// Constants
// ============================================================================

export const FHE_SCHEME = "fhe-confidential-v1" as const;

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
}

export interface MppChallenge {
  id: string;
  realm: string;
  method: string;
  intent: "charge";
  request: string; // base64-encoded requirements
}

export interface MppVerifyResult {
  valid: boolean;
  txHash?: string;
  from?: string;
  amount?: string;
  error?: string;
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

/** Payment credential sent by client (base64-encoded in Authorization header) */
export interface MppCredential {
  scheme: typeof FHE_SCHEME;
  txHash: string;
  verifierTxHash: string;
  nonce: string;
  from: string;
  chainId: number;
  signature: string;
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
// Signature helpers
// ============================================================================

function canonicalCredentialMessage(data: Record<string, unknown>): string {
  const sorted = Object.keys(data)
    .filter((k) => k !== "signature")
    .sort()
    .reduce((obj, key) => ({ ...obj, [key]: data[key] }), {});
  return JSON.stringify(sorted);
}

function verifyCredentialSignature(credential: MppCredential): boolean {
  if (!credential.signature) return false;
  try {
    const message = canonicalCredentialMessage(credential as unknown as Record<string, unknown>);
    const recovered = ethers.verifyMessage(message, credential.signature);
    return recovered.toLowerCase() === credential.from.toLowerCase();
  } catch {
    return false;
  }
}

// ============================================================================
// Base64 helpers
// ============================================================================

function base64Encode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

function base64Decode<T>(str: string): T {
  const json = Buffer.from(str, "base64").toString("utf-8");
  return JSON.parse(json) as T;
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
}

// ============================================================================
// Server-side: Create MPP challenge
// ============================================================================

/**
 * Generate an MPP-compatible 402 challenge with FHE payment option.
 *
 * The challenge follows the MPP IETF draft spec format, with `request`
 * containing a base64-encoded payload describing the FHE payment requirements.
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
 *   .json({ error: "Payment required" });
 * ```
 */
export function createMppChallenge(config: MarcMppConfig): MppChallenge {
  const requestPayload: MppRequestPayload = {
    scheme: FHE_SCHEME,
    network: `eip155:${config.chainId}`,
    tokenAddress: config.tokenAddress,
    verifierAddress: config.verifierAddress,
    recipientAddress: config.recipientAddress,
    amount: config.amount,
  };

  return {
    id: generateChallengeId(),
    realm: config.realm || "marc-protocol",
    method: "fhe-confidential",
    intent: "charge",
    request: base64Encode(requestPayload),
  };
}

/**
 * Format an MppChallenge into a WWW-Authenticate header value.
 *
 * Follows the MPP IETF draft format:
 * `Payment realm="marc-protocol", method="fhe-confidential", intent="charge", request="base64..."`
 */
export function formatMppChallenge(challenge: MppChallenge): string {
  return [
    `Payment realm="${challenge.realm}"`,
    `method="${challenge.method}"`,
    `intent="${challenge.intent}"`,
    `id="${challenge.id}"`,
    `request="${challenge.request}"`,
  ].join(", ");
}

/**
 * Parse a WWW-Authenticate header value into an MppChallenge.
 *
 * Extracts realm, method, intent, id, and request from the header.
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

  return { id, realm, method, intent, request };
}

/**
 * Decode the request field of an MppChallenge into its typed payload.
 */
export function decodeMppRequest(challenge: MppChallenge): MppRequestPayload {
  return base64Decode<MppRequestPayload>(challenge.request);
}

// ============================================================================
// Server-side: Verify MPP credential
// ============================================================================

/**
 * Verify an MPP credential (FHE payment proof).
 *
 * Steps:
 * 1. Decode base64 credential into MppCredential
 * 2. Verify ECDSA signature
 * 3. Verify on-chain events (ConfidentialTransfer + PaymentVerified)
 * 4. Return verification result
 *
 * Usage:
 * ```ts
 * const authHeader = req.headers.authorization;
 * const credential = authHeader.slice('Payment credential="'.length).replace(/"/g, "");
 * const result = await verifyMppCredential(credential, config);
 * if (!result.valid) {
 *   res.status(401).json({ error: result.error });
 * }
 * ```
 */
export async function verifyMppCredential(
  credential: string,
  config: MarcMppConfig,
): Promise<MppVerifyResult> {
  // Decode credential
  let cred: MppCredential;
  try {
    cred = base64Decode<MppCredential>(credential);
  } catch {
    return { valid: false, error: "Invalid credential encoding" };
  }

  // Validate scheme
  if (cred.scheme !== FHE_SCHEME) {
    return { valid: false, error: `Unsupported scheme: ${cred.scheme}` };
  }

  // Validate required fields
  if (!cred.txHash || !cred.nonce || !cred.from || !cred.signature) {
    return { valid: false, error: "Missing required credential fields" };
  }

  // Validate chain ID
  if (cred.chainId !== config.chainId) {
    return { valid: false, error: `Chain ID mismatch: expected ${config.chainId}, got ${cred.chainId}` };
  }

  // Validate nonce format
  if (!/^0x[0-9a-fA-F]{64}$/.test(cred.nonce)) {
    return { valid: false, error: "Invalid nonce format" };
  }

  // Verify ECDSA signature
  if (!verifyCredentialSignature(cred)) {
    return { valid: false, error: "Invalid credential signature" };
  }

  // Verify on-chain events
  const provider = new JsonRpcProvider(config.rpcUrl);

  try {
    // Verify ConfidentialTransfer event
    const receipt = await provider.getTransactionReceipt(cred.txHash);
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
          parsed.args[0].toLowerCase() === cred.from.toLowerCase() &&
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
    if (cred.verifierTxHash) {
      const vReceipt = await provider.getTransactionReceipt(cred.verifierTxHash);
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
            parsed.args[0].toLowerCase() === cred.from.toLowerCase() &&
            parsed.args[1].toLowerCase() === config.recipientAddress.toLowerCase() &&
            parsed.args[2] === cred.nonce
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

    return {
      valid: true,
      txHash: cred.txHash,
      from: cred.from,
      amount: config.amount,
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
 * 4. Return base64 credential for Authorization header
 *
 * Usage:
 * ```ts
 * const response = await fetch("https://api.example.com/premium");
 * if (response.status === 402) {
 *   const { credential, txHash } = await handleMpp402(response, signer, fhevmInstance);
 *   const retryResponse = await fetch("https://api.example.com/premium", {
 *     headers: { Authorization: `Payment credential="${credential}"` },
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

  // Sign credential
  const credData = {
    scheme: FHE_SCHEME,
    txHash: tx.hash,
    verifierTxHash: vTx.hash,
    nonce,
    from: signerAddress,
    chainId,
  };
  const signature = await signer.signMessage(canonicalCredentialMessage(credData));
  const cred: MppCredential = { ...credData, signature };

  return {
    credential: base64Encode(cred),
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
 * - Authorization: Payment credential="..." header: verifies the FHE payment credential
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
export function mppFhePaywall(config: MarcMppConfig) {
  if (!ethers.isAddress(config.tokenAddress)) {
    throw new Error(`Invalid token address: ${config.tokenAddress}`);
  }
  if (!ethers.isAddress(config.verifierAddress)) {
    throw new Error(`Invalid verifier address: ${config.verifierAddress}`);
  }
  if (!ethers.isAddress(config.recipientAddress)) {
    throw new Error(`Invalid recipient address: ${config.recipientAddress}`);
  }

  const nonceStore = new InMemoryNonceStore();

  return async (
    req: { method: string; headers: Record<string, string | undefined> },
    res: {
      status: (code: number) => any;
      json: (body: unknown) => void;
      setHeader: (key: string, value: string) => void;
    },
    next: () => void,
  ) => {
    const authHeader = req.headers["authorization"];

    // No Authorization header with Payment scheme -> return 402
    if (!authHeader || !authHeader.startsWith("Payment ")) {
      const challenge = createMppChallenge(config);
      const wwwAuth = formatMppChallenge(challenge);

      res.setHeader("WWW-Authenticate", wwwAuth);
      res.status(402).json({
        error: "Payment required",
        challenge: {
          id: challenge.id,
          method: challenge.method,
          intent: challenge.intent,
        },
      });
      return;
    }

    // Extract credential from Authorization header
    // Format: Authorization: Payment credential="base64..."
    const credMatch = authHeader.match(/credential="([^"]*)"/);
    if (!credMatch || !credMatch[1]) {
      res.status(400).json({ error: "Malformed Authorization header: missing credential" });
      return;
    }
    const credential = credMatch[1];

    // Size check
    if (credential.length > 100 * 1024) {
      res.status(400).json({ error: "Credential too large" });
      return;
    }

    // Decode credential for nonce check
    let cred: MppCredential;
    try {
      cred = base64Decode<MppCredential>(credential);
    } catch {
      res.status(400).json({ error: "Invalid credential encoding" });
      return;
    }

    // Nonce format validation
    if (!cred.nonce || !/^0x[0-9a-fA-F]{64}$/.test(cred.nonce)) {
      res.status(400).json({ error: "Invalid nonce format" });
      return;
    }

    // Nonce replay prevention
    if (!nonceStore.checkAndAdd(cred.nonce)) {
      res.status(400).json({ error: "Nonce already used" });
      return;
    }

    // Verify credential
    const result = await verifyMppCredential(credential, config);

    if (!result.valid) {
      res.status(401).json({ error: result.error ?? "Invalid payment" });
      return;
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
 * by making FHE payments and retrying with Authorization: Payment header.
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

    // Retry with Authorization header
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set("Authorization", `Payment credential="${credential}"`);

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

// Re-exports for direct use
export {
  base64Encode,
  base64Decode,
  canonicalCredentialMessage,
  verifyCredentialSignature,
};
