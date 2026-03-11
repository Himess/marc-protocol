/**
 * ERC-8004 integration helpers for FHE x402.
 * Generates registration file entries, payment proof for feedback,
 * and contract interaction for Identity & Reputation registries.
 */

import { Contract, ethers } from "ethers";
import type { Signer } from "ethers";

export interface FhePaymentMethod {
  scheme: "fhe-confidential-v1";
  network: string;
  token: string;
  tokenAddress: string;
  verifier: string;
  privacyLevel: "encrypted-balances";
  features: string[];
  description: string;
}

export interface PaymentProofForFeedback {
  type: "fhe-x402-nonce";
  nonce: string;
  tokenAddress: string;
  network: string;
  timestamp: number;
}

/**
 * Generate ERC-8004 compatible payment method entry
 * for agent registration files.
 */
export function fhePaymentMethod(config: {
  tokenAddress: string;
  verifierAddress: string;
  facilitatorUrl?: string;
  network?: string;
  token?: string;
}): FhePaymentMethod {
  return {
    scheme: "fhe-confidential-v1",
    network: config.network || "eip155:11155111",
    token: config.token || "USDC",
    tokenAddress: config.tokenAddress,
    verifier: config.verifierAddress,
    privacyLevel: "encrypted-balances",
    features: [
      "fhe-encrypted-amounts",
      "token-centric",
      "fee-free-transfers",
    ],
    description: "FHE-encrypted x402 payment via ConfidentialUSDC token",
  };
}

/**
 * Generate proof-of-payment for ERC-8004 feedback submission.
 * Uses nonce as proof that a real payment was made,
 * without revealing the encrypted amount.
 */
export function fhePaymentProof(
  nonce: string,
  tokenAddress: string,
  network?: string
): PaymentProofForFeedback {
  return {
    type: "fhe-x402-nonce",
    nonce,
    tokenAddress,
    network: network || "eip155:11155111",
    timestamp: Date.now(),
  };
}

// ============================================================================
// ERC-8004 Identity & Reputation ABIs
// ============================================================================

/** Minimal ABI for ERC-8004 Identity Registry */
export const ERC8004_IDENTITY_ABI = [
  "function register(string calldata agentURI) external returns (uint256)",
  "function setAgentWallet(uint256 agentId, address wallet) external",
  "function getAgent(uint256 agentId) external view returns (string memory uri, address owner, address wallet)",
  "function agentOf(address wallet) external view returns (uint256)",
  "event AgentRegistered(uint256 indexed agentId, address indexed owner, string agentURI)",
] as const;

/** Minimal ABI for ERC-8004 Reputation Registry */
export const ERC8004_REPUTATION_ABI = [
  "function giveFeedback(uint256 agentId, uint8 score, bytes32[] calldata tags, bytes calldata proofOfPayment) external",
  "function getSummary(uint256 agentId) external view returns (uint256 totalFeedback, uint256 averageScore, uint256 lastUpdated)",
  "function getFeedback(uint256 agentId, uint256 index) external view returns (address reviewer, uint8 score, bytes32[] memory tags, uint256 timestamp)",
  "event FeedbackGiven(uint256 indexed agentId, address indexed reviewer, uint8 score)",
] as const;

// ============================================================================
// Agent Registration helpers
// ============================================================================

export interface AgentRegistration {
  x402Support: true;
  scheme: "fhe-confidential-v1";
  services: string[];
  registrations: {
    standard: "ERC-8004";
    network: string;
  }[];
  paymentMethod: FhePaymentMethod;
}

/**
 * Create an ERC-8004 compatible agent registration object.
 * Suitable for JSON serialization as the agent's URI payload.
 */
export function createAgentRegistration(config: {
  services: string[];
  tokenAddress: string;
  verifierAddress: string;
  network?: string;
  token?: string;
}): AgentRegistration {
  const network = config.network || "eip155:11155111";
  return {
    x402Support: true,
    scheme: "fhe-confidential-v1",
    services: config.services,
    registrations: [
      {
        standard: "ERC-8004",
        network,
      },
    ],
    paymentMethod: fhePaymentMethod({
      tokenAddress: config.tokenAddress,
      verifierAddress: config.verifierAddress,
      network,
      token: config.token,
    }),
  };
}

// ============================================================================
// Feedback helpers
// ============================================================================

export interface FeedbackData {
  agentId: bigint;
  score: number;
  tags: string[];
  proofOfPayment: string;
}

/**
 * Generate parameters for the giveFeedback contract call.
 * Encodes tags as bytes32 values and packages proof of payment.
 */
export function generateFeedbackData(
  agentId: bigint | number,
  score: number,
  tags: string[],
  proofOfPayment: PaymentProofForFeedback
): FeedbackData {
  if (score < 0 || score > 255) throw new Error("Score must be 0-255 (uint8)");
  return {
    agentId: BigInt(agentId),
    score,
    tags,
    proofOfPayment: JSON.stringify(proofOfPayment),
  };
}

// ============================================================================
// Contract interaction — real on-chain calls
// ============================================================================

/**
 * Connect to an ERC-8004 Identity Registry contract.
 */
export function connectIdentityRegistry(address: string, signer: Signer): Contract {
  return new Contract(address, ERC8004_IDENTITY_ABI, signer);
}

/**
 * Connect to an ERC-8004 Reputation Registry contract.
 */
export function connectReputationRegistry(address: string, signer: Signer): Contract {
  return new Contract(address, ERC8004_REPUTATION_ABI, signer);
}

/**
 * Register an agent on the ERC-8004 Identity Registry.
 * @returns agentId from the AgentRegistered event
 */
export async function registerAgent(
  registry: Contract,
  agentURI: string
): Promise<{ agentId: bigint; txHash: string }> {
  const tx = await registry.register(agentURI);
  const receipt = await tx.wait();

  for (const log of receipt.logs) {
    try {
      const parsed = registry.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "AgentRegistered") {
        return { agentId: BigInt(parsed.args[0]), txHash: receipt.hash };
      }
    } catch { continue; }
  }

  throw new Error("AgentRegistered event not found in receipt");
}

/**
 * Set an agent's wallet address.
 */
export async function setAgentWallet(
  registry: Contract,
  agentId: bigint | number,
  wallet: string
): Promise<string> {
  const tx = await registry.setAgentWallet(agentId, wallet);
  const receipt = await tx.wait();
  return receipt.hash;
}

/**
 * Get agent details from the Identity Registry.
 */
export async function getAgent(
  registry: Contract,
  agentId: bigint | number
): Promise<{ uri: string; owner: string; wallet: string }> {
  const result = await registry.getAgent(agentId);
  return { uri: result[0], owner: result[1], wallet: result[2] };
}

/**
 * Look up agent ID by wallet address.
 */
export async function agentOf(
  registry: Contract,
  wallet: string
): Promise<bigint> {
  return BigInt(await registry.agentOf(wallet));
}

/**
 * Submit feedback for an agent on the Reputation Registry.
 */
export async function giveFeedback(
  reputation: Contract,
  feedback: FeedbackData
): Promise<string> {
  // Encode tags as bytes32
  const tagBytes = feedback.tags.map((tag) =>
    ethers.encodeBytes32String(tag.slice(0, 31))
  );
  // Encode proof of payment
  const proofBytes = ethers.toUtf8Bytes(feedback.proofOfPayment);

  const tx = await reputation.giveFeedback(
    feedback.agentId,
    feedback.score,
    tagBytes,
    proofBytes
  );
  const receipt = await tx.wait();
  return receipt.hash;
}

/**
 * Get reputation summary for an agent.
 */
export async function getReputationSummary(
  reputation: Contract,
  agentId: bigint | number
): Promise<{ totalFeedback: bigint; averageScore: bigint; lastUpdated: bigint }> {
  const result = await reputation.getSummary(agentId);
  return {
    totalFeedback: BigInt(result[0]),
    averageScore: BigInt(result[1]),
    lastUpdated: BigInt(result[2]),
  };
}
