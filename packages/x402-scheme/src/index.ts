// SPDX-License-Identifier: BUSL-1.1

/**
 * @marc-protocol/x402-scheme
 *
 * Registers MARC Protocol's `fhe-confidential-v1` as a scheme compatible with
 * the official x402 SDK ecosystem. Any x402 facilitator or server can use this
 * scheme object to issue, verify, and handle FHE confidential payments.
 */

import { Contract, JsonRpcProvider, ethers } from "ethers";
import type { Signer } from "ethers";

// ============================================================================
// Constants
// ============================================================================

export const FHE_SCHEME = "fhe-confidential-v1" as const;

export const SUPPORTED_CHAINS: Record<number, string> = {
  1: "Ethereum",
  11155111: "Sepolia",
  8453: "Base",
  42161: "Arbitrum",
};

// ============================================================================
// Types
// ============================================================================

/** Minimal @zama-fhe/relayer-sdk interface (avoid hard dependency) */
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

/** x402 payment requirements (server sends in 402 body) */
export interface FhePaymentRequirements {
  scheme: typeof FHE_SCHEME;
  network: string;
  chainId: number;
  price: string;
  asset: string;
  tokenAddress: string;
  verifierAddress: string;
  recipientAddress: string;
  maxTimeoutSeconds: number;
}

/** 402 response body */
export interface FhePaymentRequired {
  x402Version: 1;
  accepts: FhePaymentRequirements[];
  resource: { url: string; method: string };
  error?: string;
}

/** Client-side payment payload (base64-encoded in Payment header) */
export interface FhePaymentPayload {
  scheme: typeof FHE_SCHEME;
  txHash: string;
  verifierTxHash: string;
  nonce: string;
  from: string;
  chainId: number;
  signature: string;
}

/** Server-side paywall config */
export interface FhePaywallConfig {
  price: number | string;
  asset: string;
  tokenAddress: string;
  verifierAddress: string;
  recipientAddress: string;
  rpcUrl: string;
  chainId?: number;
  maxTimeoutSeconds?: number;
}

/** Payment verification result */
export interface VerifyResult {
  valid: boolean;
  from?: string;
  txHash?: string;
  verifierTxHash?: string;
  nonce?: string;
  blockNumber?: number;
  error?: string;
}

/** x402 scheme challenge (returned to client in 402 body) */
export interface SchemeChallenge {
  x402Version: 1;
  accepts: FhePaymentRequirements[];
  resource: { url: string; method: string };
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

function canonicalPayloadMessage(data: Record<string, unknown>): string {
  const sorted = Object.keys(data)
    .filter((k) => k !== "signature")
    .sort()
    .reduce((obj, key) => ({ ...obj, [key]: data[key] }), {});
  return JSON.stringify(sorted);
}

function verifyPaymentSignature(payload: FhePaymentPayload): boolean {
  if (!payload.signature) return false;
  try {
    const message = canonicalPayloadMessage(payload as unknown as Record<string, unknown>);
    const recovered = ethers.verifyMessage(message, payload.signature);
    return recovered.toLowerCase() === payload.from.toLowerCase();
  } catch {
    return false;
  }
}

function encodePaymentHeader(payload: FhePaymentPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function decodePaymentHeader(header: string): FhePaymentPayload {
  const json = Buffer.from(header, "base64").toString("utf-8");
  const parsed = JSON.parse(json);
  if (
    !parsed ||
    typeof parsed.scheme !== "string" ||
    typeof parsed.txHash !== "string" ||
    typeof parsed.verifierTxHash !== "string" ||
    typeof parsed.nonce !== "string" ||
    typeof parsed.from !== "string" ||
    typeof parsed.chainId !== "number" ||
    typeof parsed.signature !== "string"
  ) {
    throw new Error("Invalid payment payload: missing required fields");
  }
  return parsed as FhePaymentPayload;
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
// FHE_CONFIDENTIAL_SCHEME — x402 scheme object
// ============================================================================

/**
 * x402-compatible scheme for FHE confidential payments.
 *
 * Usage with any x402 facilitator or server:
 * ```ts
 * import { FHE_CONFIDENTIAL_SCHEME } from "@marc-protocol/x402-scheme";
 *
 * // Client: create payment from a 402 challenge
 * const { paymentHeader, txHash } = await FHE_CONFIDENTIAL_SCHEME.createPayment(
 *   challenge, signer, fhevmInstance
 * );
 *
 * // Server: verify a payment credential
 * const result = await FHE_CONFIDENTIAL_SCHEME.verifyPayment(paymentHeader, config);
 *
 * // Server: generate 402 requirements
 * const requirements = FHE_CONFIDENTIAL_SCHEME.getRequirements(config);
 * ```
 */
export const FHE_CONFIDENTIAL_SCHEME = {
  name: FHE_SCHEME,
  version: "1.0.0",

  /**
   * Client-side: Create an FHE payment for a 402 challenge.
   *
   * Encrypts the amount using FHEVM, calls cUSDC.confidentialTransfer(),
   * then records the payment nonce via verifier.recordPayment().
   *
   * @param challenge - The 402 challenge body (FhePaymentRequired)
   * @param signer - ethers.js Signer with cUSDC balance
   * @param fhevmInstance - @zama-fhe/relayer-sdk instance for FHE encryption
   * @returns Payment header (base64), txHash, verifierTxHash, nonce
   */
  createPayment: async (
    challenge: FhePaymentRequired,
    signer: Signer,
    fhevmInstance: FhevmInstance,
  ): Promise<{
    paymentHeader: string;
    txHash: string;
    verifierTxHash: string;
    nonce: string;
  }> => {
    // Select a matching FHE requirement from the challenge
    const requirement = challenge.accepts.find((r) => r.scheme === FHE_SCHEME);
    if (!requirement) {
      throw new Error("No fhe-confidential-v1 requirement in challenge");
    }

    const signerAddress = await signer.getAddress();
    const amount = BigInt(requirement.price);
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    // Encrypt amount with FHEVM
    const input = fhevmInstance.createEncryptedInput(requirement.tokenAddress, signerAddress);
    input.add64(amount);
    const encrypted = await input.encrypt();

    if (!encrypted.handles || encrypted.handles.length === 0) {
      throw new Error("FHE encryption returned no handles");
    }

    // Step 1: confidentialTransfer (fee-free agent-to-agent)
    const token = new Contract(requirement.tokenAddress, TOKEN_ABI, signer);
    const tx = await token.confidentialTransfer(
      requirement.recipientAddress,
      encrypted.handles[0],
      encrypted.inputProof,
    );
    const receipt = await tx.wait();

    if (!receipt || receipt.status === 0) {
      throw new Error(`Payment transaction failed: ${tx.hash}`);
    }

    // Step 2: recordPayment (on-chain nonce + minPrice)
    const verifier = new Contract(requirement.verifierAddress, VERIFIER_ABI, signer);
    const vTx = await verifier.recordPayment(requirement.recipientAddress, nonce, amount);
    const vReceipt = await vTx.wait();

    if (!vReceipt || vReceipt.status === 0) {
      throw new Error(`Verifier recordPayment failed. Transfer TX succeeded: ${tx.hash}`);
    }

    // Sign payload
    const payloadData = {
      scheme: FHE_SCHEME,
      txHash: tx.hash,
      verifierTxHash: vTx.hash,
      nonce,
      from: signerAddress,
      chainId: requirement.chainId,
    };
    const signature = await signer.signMessage(canonicalPayloadMessage(payloadData));
    const payload: FhePaymentPayload = { ...payloadData, signature };

    return {
      paymentHeader: encodePaymentHeader(payload),
      txHash: tx.hash,
      verifierTxHash: vTx.hash,
      nonce,
    };
  },

  /**
   * Server-side: Verify an FHE payment credential.
   *
   * Decodes the base64 payment header, verifies the ECDSA signature,
   * then checks on-chain events (ConfidentialTransfer + PaymentVerified).
   *
   * @param credential - base64-encoded payment header from client
   * @param config - Server paywall configuration
   * @returns Verification result with valid flag and payment details
   */
  verifyPayment: async (credential: string, config: FhePaywallConfig): Promise<VerifyResult> => {
    // Decode payment header
    let payload: FhePaymentPayload;
    try {
      payload = decodePaymentHeader(credential);
    } catch {
      return { valid: false, error: "Invalid payment header encoding" };
    }

    // Validate scheme
    if (payload.scheme !== FHE_SCHEME) {
      return { valid: false, error: `Unsupported scheme: ${payload.scheme}` };
    }

    // Validate chain ID
    const chainId = config.chainId ?? 11155111;
    if (payload.chainId !== chainId) {
      return { valid: false, error: `Chain ID mismatch: expected ${chainId}, got ${payload.chainId}` };
    }

    // Validate nonce format
    if (!/^0x[0-9a-fA-F]{64}$/.test(payload.nonce)) {
      return { valid: false, error: "Invalid nonce format" };
    }

    // Verify ECDSA signature
    if (!verifyPaymentSignature(payload)) {
      return { valid: false, error: "Invalid payment signature" };
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

      // Verify PaymentVerified event (dual-TX flow)
      if (payload.verifierTxHash) {
        const vReceipt = await provider.getTransactionReceipt(payload.verifierTxHash);
        if (!vReceipt || vReceipt.status === 0) {
          return { valid: false, error: "Verifier transaction failed or not found" };
        }

        const verifierIface = new ethers.Interface(VERIFIER_ABI);
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
              const eventMinPrice = BigInt(parsed.args[3]);
              if (eventMinPrice < requiredPrice) {
                return {
                  valid: false,
                  error: `Insufficient minPrice: committed ${eventMinPrice}, required ${requiredPrice}`,
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
        from: payload.from,
        txHash: payload.txHash,
        verifierTxHash: payload.verifierTxHash,
        nonce: payload.nonce,
        blockNumber: receipt.blockNumber,
      };
    } catch (err) {
      return {
        valid: false,
        error: `On-chain verification failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },

  /**
   * Server-side: Generate 402 response requirements for this scheme.
   *
   * @param config - Paywall configuration
   * @returns x402 payment requirements object to include in 402 response body
   */
  getRequirements: (config: FhePaywallConfig): FhePaymentRequirements => {
    const chainId = config.chainId ?? 11155111;
    return {
      scheme: FHE_SCHEME,
      network: `eip155:${chainId}`,
      chainId,
      price: String(config.price),
      asset: config.asset,
      tokenAddress: config.tokenAddress,
      verifierAddress: config.verifierAddress,
      recipientAddress: config.recipientAddress,
      maxTimeoutSeconds: config.maxTimeoutSeconds ?? 300,
    };
  },
};

// ============================================================================
// Express middleware — createFhePaywall
// ============================================================================

/**
 * Creates an Express middleware that puts an FHE x402 paywall on a route.
 *
 * Usage:
 * ```ts
 * import { createFhePaywall } from "@marc-protocol/x402-scheme";
 *
 * app.use("/api/premium", createFhePaywall({
 *   price: "1000000", // 1 USDC
 *   asset: "USDC",
 *   tokenAddress: "0xE944...",
 *   verifierAddress: "0x4503...",
 *   recipientAddress: "0xYourAddress",
 *   rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
 * }));
 * ```
 */
export function createFhePaywall(config: FhePaywallConfig) {
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
    req: { method: string; protocol?: string; originalUrl?: string; headers: Record<string, string | undefined>; get?: (key: string) => string | undefined },
    res: { status: (code: number) => any; json: (body: unknown) => void; setHeader: (key: string, value: string) => void },
    next: () => void,
  ) => {
    const paymentHeader = req.headers["payment"];

    if (!paymentHeader) {
      const host = req.get?.("host") ?? "localhost";
      const requestUrl = `${req.protocol ?? "https"}://${host}${req.originalUrl ?? "/"}`;

      const requirements = FHE_CONFIDENTIAL_SCHEME.getRequirements(config);

      const body: FhePaymentRequired = {
        x402Version: 1,
        accepts: [requirements],
        resource: { url: requestUrl, method: req.method },
      };

      res.status(402).json(body);
      return;
    }

    // Size check
    if (paymentHeader.length > 100 * 1024) {
      res.status(400).json({ error: "Payment header too large" });
      return;
    }

    // Decode and verify
    let payload: FhePaymentPayload;
    try {
      payload = decodePaymentHeader(paymentHeader);
    } catch {
      res.status(400).json({ error: "Invalid Payment header encoding" });
      return;
    }

    if (payload.scheme !== FHE_SCHEME) {
      res.status(400).json({ error: "Unsupported payment scheme" });
      return;
    }

    if (!verifyPaymentSignature(payload)) {
      res.status(400).json({ error: "Invalid payment signature" });
      return;
    }

    // Nonce replay prevention
    if (!nonceStore.checkAndAdd(payload.nonce)) {
      res.status(400).json({ error: "Nonce already used" });
      return;
    }

    // On-chain verification
    const result = await FHE_CONFIDENTIAL_SCHEME.verifyPayment(paymentHeader, config);

    if (!result.valid) {
      res.status(400).json({ error: result.error ?? "Payment verification failed" });
      return;
    }

    res.setHeader("X-Payment-TxHash", payload.txHash);
    next();
  };
}

// ============================================================================
// Client fetch wrapper — createFheFetch
// ============================================================================

/**
 * Creates an x402-aware fetch function that automatically handles 402 responses
 * by encrypting an FHE payment and retrying with the Payment header.
 *
 * Usage:
 * ```ts
 * import { createFheFetch } from "@marc-protocol/x402-scheme";
 *
 * const fheFetch = createFheFetch(signer, fhevmInstance);
 * const response = await fheFetch("https://api.example.com/premium");
 * ```
 */
export function createFheFetch(
  signer: Signer,
  fhevmInstance: FhevmInstance,
  options?: { maxPayment?: bigint; allowedNetworks?: string[]; timeoutMs?: number },
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const maxPayment = options?.maxPayment;
  const allowedNetworks = options?.allowedNetworks;

  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const response = await fetchWithTimeout(url, init ?? {}, timeoutMs);

    if (response.status !== 402) return response;

    // Parse 402 body
    let body: FhePaymentRequired;
    try {
      body = await response.clone().json();
    } catch {
      return response;
    }

    if (!body || body.x402Version !== 1 || !Array.isArray(body.accepts)) {
      return response;
    }

    // Find matching FHE requirement
    const requirement = body.accepts.find((r) => {
      if (r.scheme !== FHE_SCHEME) return false;
      if (allowedNetworks?.length && !allowedNetworks.includes(r.network)) return false;
      if (maxPayment && maxPayment > 0n && BigInt(r.price) > maxPayment) return false;
      return true;
    });

    if (!requirement) return response;

    // Create payment
    const paymentResult = await FHE_CONFIDENTIAL_SCHEME.createPayment(
      { x402Version: 1, accepts: [requirement], resource: body.resource },
      signer,
      fhevmInstance,
    );

    // Retry with Payment header
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set("Payment", paymentResult.paymentHeader);

    return fetchWithTimeout(url, { ...init, headers: retryHeaders }, timeoutMs);
  };
}

// ============================================================================
// Helpers
// ============================================================================

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

// Re-exports for convenience
export { decodePaymentHeader, verifyPaymentSignature, canonicalPayloadMessage, encodePaymentHeader };
