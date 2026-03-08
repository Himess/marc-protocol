// Types
export type {
  FhePaymentRequirements,
  FhePaymentRequired,
  FhePaymentPayload,
  FhePaywallConfig,
  FheFetchOptions,
  FhevmInstance,
  FhevmEncryptedInput,
  ResourceInfo,
  PaymentInfo,
  NonceStore,
} from "./types.js";

export { FHE_SCHEME, POOL_ABI } from "./types.js";

// Payment handler (client-side)
export { FhePaymentHandler, decodePaymentHeader } from "./fhePaymentHandler.js";
export type { FhePaymentHandlerOptions, FhePaymentResult } from "./fhePaymentHandler.js";

// Paywall middleware (server-side)
export { fhePaywall } from "./fhePaywallMiddleware.js";

// Fetch wrapper (client-side)
export { fheFetch, createFheFetch, fheFetchWithCallback } from "./fheFetch.js";

// Facilitator server
export { createFacilitatorServer } from "./facilitator.js";
export type { FacilitatorConfig } from "./facilitator.js";

// ERC-8004 integration
export { fhePaymentMethod, fhePaymentProof } from "./erc8004/index.js";
export type { FhePaymentMethod, PaymentProofForFeedback } from "./erc8004/index.js";
