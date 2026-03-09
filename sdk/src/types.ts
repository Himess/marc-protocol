import type { Signer } from "ethers";

// ============================================================================
// x402 FHE Payment Types
// ============================================================================

/** Scheme identifier for this protocol */
export const FHE_SCHEME = "fhe-confidential-v1" as const;

/** Server sends in 402 response body */
export interface FhePaymentRequirements {
  scheme: typeof FHE_SCHEME;
  network: string;
  chainId: number;
  price: string; // USDC amount (6 decimals) e.g. "1000000" = 1 USDC
  asset: string; // "USDC"
  poolAddress: string;
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
  txHash: string;
  nonce: string; // bytes32 hex
  from: string;
  chainId: number;
}

/** Middleware config */
export interface FhePaywallConfig {
  price: number | string; // USDC amount (6 decimals)
  asset: string;
  poolAddress: string;
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
  nonce: string;
  blockNumber: number;
}

/** Fetch options */
export interface FheFetchOptions extends RequestInit {
  poolAddress: string;
  rpcUrl: string;
  signer: Signer;
  /** fhevmjs instance for FHE encryption */
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
  /** Optional memo to attach to payments (bytes32 hex). Defaults to 0x0. */
  memo?: string;
}

/** Minimal fhevmjs interface (avoid hard dependency) */
export interface FhevmInstance {
  createEncryptedInput: (
    contractAddress: string,
    userAddress: string
  ) => FhevmEncryptedInput;
}

export interface FhevmEncryptedInput {
  add64: (value: bigint | number) => void;
  encrypt: () => Promise<{
    handles: string[];
    inputProof: string;
  }>;
}

/**
 * External nonce store interface for persistent nonce tracking.
 * Implement this with Redis, a database, or any persistent storage
 * to survive server restarts.
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
// Contract ABI (minimal)
// ============================================================================

export const POOL_ABI = [
  "function deposit(uint64 amount) external",
  "function pay(address to, bytes32 encryptedAmount, bytes calldata inputProof, uint64 minPrice, bytes32 nonce, bytes32 memo) external",
  "function requestWithdraw(bytes32 encryptedAmount, bytes calldata inputProof) external",
  "function cancelWithdraw() external",
  "function expireWithdraw(address user) external",
  "function finalizeWithdraw(uint64 clearAmount, bytes calldata decryptionProof) external",
  "function requestBalance() external",
  "function treasuryWithdraw(uint64 amount) external",
  "function pause() external",
  "function unpause() external",
  "function setPoolCaps(uint256 _maxPoolBalance, uint256 _maxUserDeposit) external",
  "function setTreasury(address newTreasury) external",
  "function transferOwnership(address newOwner) external",
  "function acceptOwnership() external",
  "function balanceOf(address account) external view returns (bytes32)",
  "function balanceSnapshotOf(address account) external view returns (bytes32)",
  "function usedNonces(bytes32 nonce) external view returns (bool)",
  "function isInitialized(address account) external view returns (bool)",
  "function pendingWithdrawOf(address account) external view returns (bytes32)",
  "function withdrawRequestedAt(address account) external view returns (uint256)",
  "function paused() external view returns (bool)",
  "event Deposited(address indexed user, uint64 amount)",
  "event PaymentExecuted(address indexed from, address indexed to, uint64 minPrice, bytes32 nonce, bytes32 memo)",
  "event WithdrawRequested(address indexed user, uint256 expiresAt)",
  "event WithdrawCancelled(address indexed user)",
  "event WithdrawExpired(address indexed user)",
  "event WithdrawFinalized(address indexed user, uint64 amount)",
  "event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury)",
  "event TreasuryWithdrawn(address indexed treasury, uint64 amount)",
  "event BalanceRequested(address indexed user)",
  "event PoolCapUpdated(uint256 maxPoolBalance, uint256 maxUserDeposit)",
  "event Paused(address account)",
  "event Unpaused(address account)",
] as const;
