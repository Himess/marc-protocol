import type { Signer } from "ethers";

// ============================================================================
// x402 FHE Payment Types
// ============================================================================

/** Scheme identifier for this protocol */
export const FHE_SCHEME = "fhe-confidential-v1" as const;

/** Protocol fee: 10 bps (0.1%) */
export const FEE_BPS = 10n;
export const BPS = 10_000n;
/** Minimum protocol fee: 0.01 USDC (10,000 micro-USDC) */
export const MIN_PROTOCOL_FEE = 10_000n;

/** Server sends in 402 response body */
export interface FhePaymentRequirements {
  scheme: typeof FHE_SCHEME;
  network: string;
  chainId: number;
  price: string; // USDC amount (6 decimals) e.g. "1000000" = 1 USDC
  asset: string; // "USDC"
  tokenAddress: string; // ConfidentialUSDC address
  verifierAddress: string; // X402PaymentVerifier address
  recipientAddress: string;
  maxTimeoutSeconds: number;
}

/** 402 response body */
export interface FhePaymentRequired {
  x402Version: 1;
  accepts: FhePaymentRequirements[];
  resource: ResourceInfo;
  error?: string;
}

/** Client sends in Payment header (base64 JSON) */
export interface FhePaymentPayload {
  scheme: typeof FHE_SCHEME;
  txHash: string; // confidentialTransfer tx (or payAndRecord tx for V4.2)
  verifierTxHash: string; // recordPayment tx (empty string for V4.2 single-tx)
  nonce: string; // bytes32 hex
  from: string;
  chainId: number;
}

/** V4.3 — Batch prepayment payload (client sends in Payment header) */
export interface FheBatchPaymentPayload {
  scheme: typeof FHE_SCHEME;
  txHash: string; // confidentialTransfer tx for total amount
  verifierTxHash: string; // recordBatchPayment tx
  nonce: string; // bytes32 hex
  from: string;
  chainId: number;
  requestCount: number; // number of prepaid requests
  pricePerRequest: string; // price per request in USDC (6 decimals)
}

/** Middleware config */
export interface FhePaywallConfig {
  price: number | string; // USDC amount (6 decimals)
  asset: string;
  tokenAddress: string; // ConfidentialUSDC address
  verifierAddress: string; // X402PaymentVerifier address
  recipientAddress: string;
  rpcUrl: string;
  chainId?: number; // default: 11155111 (Sepolia)
  maxTimeoutSeconds?: number;
  maxRateLimit?: number;
  rateLimitWindowMs?: number;
  minConfirmations?: number; // minimum block confirmations (default: 1)
  nonceStore?: NonceStore; // external nonce persistence (default: in-memory Set)
}

/** Resource info for 402 response */
export interface ResourceInfo {
  url: string;
  method: string;
}

/** Payment info attached to req */
export interface PaymentInfo {
  from: string;
  amount: string;
  asset: string;
  recipient: string;
  txHash: string;
  verifierTxHash: string;
  nonce: string;
  blockNumber: number;
}

/** Fetch options */
export interface FheFetchOptions extends RequestInit {
  tokenAddress: string;
  verifierAddress: string;
  rpcUrl: string;
  signer: Signer;
  /** @zama-fhe/relayer-sdk instance for FHE encryption */
  fhevmInstance: FhevmInstance;
  maxPayment?: bigint;
  allowedNetworks?: string[];
  dryRun?: boolean;
  /** Timeout in milliseconds for HTTP requests (default: 30000) */
  timeoutMs?: number;
  /** Number of retry attempts for failed HTTP retries after payment (default: 0) */
  maxRetries?: number;
  /** Base delay between retries in ms, with linear backoff (default: 1000) */
  retryDelayMs?: number;
  /** V4.2: Use single-TX payment via verifier.payAndRecord() instead of dual-TX (default: false) */
  preferSingleTx?: boolean;
}

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

/**
 * External nonce store interface for persistent nonce tracking.
 * Implement this with Redis, a database, or any persistent storage
 * to survive server restarts.
 *
 * NonceStore implementations may be sync or async.
 * Prefer implementing checkAndAdd() for atomic nonce checking.
 */
export interface NonceStore {
  /** Check if nonce exists. Returns true if nonce is NEW (not seen before). */
  check(nonce: string): boolean | Promise<boolean>;
  /** Mark nonce as used. */
  add(nonce: string): void | Promise<void>;
  /** Atomic check-and-add. Returns true if nonce is new, false if replay. Optional — if not provided, check+add are called separately. */
  checkAndAdd?(nonce: string): boolean | Promise<boolean>;
}

// ============================================================================
// Contract ABIs (minimal)
// ============================================================================

/** ConfidentialUSDC token ABI */
export const TOKEN_ABI = [
  // ERC-7984 inherited
  "function name() external view returns (string)",
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
  "function confidentialTotalSupply() external view returns (bytes32)",
  "function confidentialBalanceOf(address account) external view returns (bytes32)",
  "function confidentialTransfer(address to, bytes32 encryptedAmount, bytes calldata inputProof) external returns (bytes32)",
  "function setOperator(address operator, uint48 until) external",
  "function isOperator(address holder, address spender) external view returns (bool)",
  // ERC7984ERC20Wrapper inherited
  "function wrap(address to, uint256 amount) external",
  "function unwrap(address from, address to, bytes32 encryptedAmount, bytes calldata inputProof) external",
  "function finalizeUnwrap(bytes32 burntAmount, uint64 burntAmountCleartext, bytes calldata decryptionProof) external",
  "function underlying() external view returns (address)",
  "function rate() external view returns (uint256)",
  // ConfidentialUSDC specific
  "function treasury() external view returns (address)",
  "function accumulatedFees() external view returns (uint256)",
  "function setTreasury(address newTreasury) external",
  "function treasuryWithdraw() external",
  "function pause() external",
  "function unpause() external",
  "function paused() external view returns (bool)",
  "function transferOwnership(address newOwner) external",
  "function acceptOwnership() external",
  // ERC-7984 events
  "event ConfidentialTransfer(address indexed from, address indexed to, bytes32 indexed amount)",
  "event OperatorSet(address indexed holder, address indexed operator, uint48 until)",
  // ERC7984ERC20Wrapper events
  "event UnwrapRequested(address indexed receiver, bytes32 amount)",
  "event UnwrapFinalized(address indexed receiver, bytes32 encryptedAmount, uint64 cleartextAmount)",
  // ConfidentialUSDC events
  "event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury)",
  "event TreasuryWithdrawn(address indexed treasury, uint256 amount)",
] as const;

/** X402PaymentVerifier ABI */
export const VERIFIER_ABI = [
  // V4.0
  "function recordPayment(address server, bytes32 nonce, uint64 minPrice) external",
  "function usedNonces(bytes32 nonce) external view returns (bool)",
  "function trustedToken() external view returns (address)",
  "event PaymentVerified(address indexed payer, address indexed server, bytes32 indexed nonce, uint64 minPrice)",
  // V4.2 — single-TX
  "function payAndRecord(address token, address server, bytes32 nonce, uint64 minPrice, bytes32 encryptedAmount, bytes calldata inputProof) external",
  "event PayAndRecordCompleted(address indexed payer, address indexed server, bytes32 indexed nonce, address token, uint64 minPrice)",
  // V4.3 — batch prepayment
  "function recordBatchPayment(address server, bytes32 nonce, uint32 requestCount, uint64 pricePerRequest) external",
  "event BatchPaymentRecorded(address indexed payer, address indexed server, bytes32 indexed nonce, uint32 requestCount, uint64 pricePerRequest)",
] as const;
