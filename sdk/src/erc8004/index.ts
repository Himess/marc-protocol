/**
 * ERC-8004 integration helpers for FHE x402.
 * Generates registration file entries and payment proof for feedback.
 */

export interface FhePaymentMethod {
  scheme: "fhe-confidential-v1";
  network: string;
  token: string;
  pool: string;
  facilitator: string;
  privacyLevel: "encrypted-balances";
  features: string[];
  description: string;
}

export interface PaymentProofForFeedback {
  type: "fhe-x402-nonce";
  nonce: string;
  pool: string;
  network: string;
  timestamp: number;
}

/**
 * Generate ERC-8004 compatible payment method entry
 * for agent registration files.
 */
export function fhePaymentMethod(config: {
  poolAddress: string;
  facilitatorUrl?: string;
  network?: string;
  token?: string;
}): FhePaymentMethod {
  return {
    scheme: "fhe-confidential-v1",
    network: config.network || "eip155:11155111",
    token: config.token || "USDC",
    pool: config.poolAddress,
    facilitator: config.facilitatorUrl || "https://facilitator.fhe-x402.xyz",
    privacyLevel: "encrypted-balances",
    features: [
      "fhe-encrypted-amounts",
      "silent-failure-privacy",
      "async-withdraw",
    ],
    description: "FHE-encrypted x402 payment via ConfidentialPaymentPool",
  };
}

/**
 * Generate proof-of-payment for ERC-8004 feedback submission.
 * Uses nonce as proof that a real payment was made,
 * without revealing the encrypted amount.
 */
export function fhePaymentProof(
  nonce: string,
  poolAddress: string,
  network?: string
): PaymentProofForFeedback {
  return {
    type: "fhe-x402-nonce",
    nonce,
    pool: poolAddress,
    network: network || "eip155:11155111",
    timestamp: Date.now(),
  };
}
