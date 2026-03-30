// Types
export type {
  FhePaymentRequirements,
  FhePaymentRequired,
  FhePaymentPayload,
  FheBatchPaymentPayload,
  FhePaywallConfig,
  FheFetchOptions,
  FhevmInstance,
  FhevmEncryptedInput,
  ResourceInfo,
  PaymentInfo,
  NonceStore,
} from "./types.js";

export { FHE_SCHEME, TOKEN_ABI, VERIFIER_ABI, FEE_BPS, BPS, MIN_PROTOCOL_FEE } from "./types.js";

// Payment handler (client-side)
export { FhePaymentHandler, decodePaymentHeader, decodeBatchPaymentHeader, verifyPaymentSignature, canonicalPayloadMessage } from "./fhePaymentHandler.js";
export type { FhePaymentHandlerOptions, FhePaymentResult, FheBatchPaymentResult } from "./fhePaymentHandler.js";

// Paywall middleware (server-side)
export { fhePaywall, fheBatchPaywall } from "./fhePaywallMiddleware.js";

// Fetch wrapper (client-side)
export { fheFetch, createFheFetch, fheFetchWithCallback, verifyTxOnChain } from "./fheFetch.js";

// Facilitator server
export { createFacilitatorServer } from "./facilitator.js";
export type { FacilitatorConfig } from "./facilitator.js";

// ERC-8004 integration
export {
  fhePaymentMethod,
  fhePaymentProof,
  createAgentRegistration,
  generateFeedbackData,
  ERC8004_IDENTITY_ABI,
  ERC8004_REPUTATION_ABI,
  connectIdentityRegistry,
  connectReputationRegistry,
  registerAgent,
  setAgentWallet,
  getAgent,
  agentOf,
  giveFeedback,
  getReputationSummary,
} from "./erc8004/index.js";
export type { FhePaymentMethod, PaymentProofForFeedback } from "./erc8004/index.js";

// ERC-8183 Agentic Commerce
export {
  ACP_ABI,
  encodeJobDescription,
  calculatePlatformFee,
  createJobParams,
  parseJobCompletedEvent,
  connectACP,
  createJob,
  setBudget,
  fundJob,
  submitDeliverable,
  completeJob,
  rejectJob,
  claimRefund,
  getJob,
} from "./erc8183/index.js";

// Redis stores (production)
export { RedisNonceStore } from "./redisNonceStore.js";
export type { RedisNonceStoreOptions, RedisLike } from "./redisNonceStore.js";
export { RedisBatchCreditStore } from "./redisBatchCreditStore.js";
export type { BatchCreditStore, BatchCreditEntry, BatchCreditStoreOptions } from "./redisBatchCreditStore.js";

// Silent failure guard
export {
  checkSenderHasBalance,
  checkBalanceChanged,
  getBalanceBefore,
  verifyAfterTransfer,
} from "./silentFailureGuard.js";
export type { SilentFailureCheckResult } from "./silentFailureGuard.js";

// Logger
export { createLogger, setLogLevel, getLogLevel } from "./logger.js";
export type { Logger, LogLevel } from "./logger.js";

// ANSI color helpers (demo/CLI pretty-printing)
export { colors, banner, step, info, txBox, separator, success, error, warn } from "./colors.js";

// Multi-chain configuration
export { CHAINS, getChainConfig, setChainContracts } from "./chains.js";
export type { ChainConfig, ChainContracts } from "./chains.js";

// Error classes
export {
  FheX402Error,
  PaymentError,
  EncryptionError,
  VerificationError,
  TimeoutError,
  NetworkError,
  FheErrorCode,
} from "./errors.js";
