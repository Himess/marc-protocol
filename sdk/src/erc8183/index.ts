/**
 * ERC-8183 Agentic Commerce Protocol SDK helpers.
 * Provides ABI, job description encoding, fee calculation,
 * event parsing, and contract interaction for the AgenticCommerceProtocol contract.
 */

import { Contract, ethers } from "ethers";
import type { Signer } from "ethers";

// ============================================================================
// ABI
// ============================================================================

/** Minimal ABI for AgenticCommerceProtocol */
export const ACP_ABI = [
  "function createJob(address provider, address evaluator, uint256 expiredAt, string calldata description, address hook) external returns (uint256)",
  "function setProvider(uint256 jobId, address provider) external",
  "function setBudget(uint256 jobId, uint256 amount) external",
  "function fund(uint256 jobId, uint256 expectedBudget) external",
  "function submit(uint256 jobId, bytes32 deliverable) external",
  "function complete(uint256 jobId, bytes32 reason) external",
  "function reject(uint256 jobId, bytes32 reason) external",
  "function claimRefund(uint256 jobId) external",
  "function getJob(uint256 jobId) external view returns (tuple(address client, address provider, address evaluator, uint256 budget, uint256 expiredAt, uint8 status, string description, bytes32 deliverable, address hook))",
  "function paymentToken() external view returns (address)",
  "function treasury() external view returns (address)",
  "function setTreasury(address newTreasury) external",
  "function PLATFORM_FEE_BPS() external view returns (uint256)",
  "function BPS() external view returns (uint256)",
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt)",
  "event BudgetSet(uint256 indexed jobId, uint256 amount)",
  "event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount)",
  "event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)",
  "event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason)",
  "event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason)",
  "event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount)",
  "event Refunded(uint256 indexed jobId, address indexed client, uint256 amount)",
] as const;

// ============================================================================
// Constants
// ============================================================================

const PLATFORM_FEE_BPS = 100n; // 1%
const BPS = 10_000n;

// ============================================================================
// Job description encoding
// ============================================================================

/**
 * Encode a structured job description into a formatted string.
 * Used as the `description` parameter in createJob.
 */
export function encodeJobDescription(title: string, details: string, requirements: string[]): string {
  if (title.includes("|") || details.includes("|")) {
    throw new Error("Job description fields must not contain '|' character");
  }

  const parts: string[] = [];

  if (title) {
    parts.push(`[Title] ${title}`);
  }

  if (details) {
    parts.push(`[Details] ${details}`);
  }

  if (requirements.length > 0) {
    parts.push(`[Requirements] ${requirements.join("; ")}`);
  }

  return parts.join(" | ");
}

// ============================================================================
// Fee calculation
// ============================================================================

export interface FeeBreakdown {
  fee: bigint;
  payout: bigint;
}

/**
 * Calculate the platform fee and provider payout for a given budget.
 * Fee is 1% (100 bps) of the budget.
 * Rounds down (matches on-chain Solidity integer division behavior).
 *
 * @param budget - Job budget in token units (e.g. USDC with 6 decimals)
 * @returns { fee, payout } where fee + payout = budget
 */
export function calculatePlatformFee(budget: bigint): FeeBreakdown {
  const fee = (budget * PLATFORM_FEE_BPS) / BPS;
  const payout = budget - fee;
  return { fee, payout };
}

// ============================================================================
// Job creation params
// ============================================================================

export interface JobParams {
  provider: string;
  evaluator: string;
  expiredAt: number;
  description: string;
  hook: string;
}

/**
 * Create parameters for the createJob contract call.
 */
export function createJobParams(config: {
  provider: string;
  evaluator: string;
  expiredAt: number;
  title: string;
  details: string;
  requirements: string[];
  hook?: string;
}): JobParams {
  return {
    provider: config.provider,
    evaluator: config.evaluator,
    expiredAt: config.expiredAt,
    description: encodeJobDescription(config.title, config.details, config.requirements),
    hook: config.hook || "0x0000000000000000000000000000000000000000",
  };
}

// ============================================================================
// Event parsing
// ============================================================================

export interface JobCompletedData {
  jobId: bigint;
  evaluator: string;
  reason: string;
}

export interface PaymentReleasedData {
  jobId: bigint;
  provider: string;
  amount: bigint;
}

export interface ParsedCompletionEvents {
  jobCompleted: JobCompletedData | null;
  paymentReleased: PaymentReleasedData | null;
}

/**
 * Parse JobCompleted and PaymentReleased events from a transaction receipt.
 * Works with ethers v6 TransactionReceipt logs.
 *
 * @param receipt - Transaction receipt with logs
 * @returns Parsed event data or null for each event
 */
export function parseJobCompletedEvent(receipt: {
  logs: Array<{
    topics: string[];
    data: string;
    fragment?: { name: string };
    args?: any[];
  }>;
}): ParsedCompletionEvents {
  let jobCompleted: JobCompletedData | null = null;
  let paymentReleased: PaymentReleasedData | null = null;

  for (const log of receipt.logs) {
    if (log.fragment?.name === "JobCompleted" && log.args && log.args.length >= 3) {
      jobCompleted = {
        jobId: BigInt(log.args[0]),
        evaluator: String(log.args[1]),
        reason: String(log.args[2]),
      };
    }
    if (log.fragment?.name === "PaymentReleased" && log.args && log.args.length >= 3) {
      paymentReleased = {
        jobId: BigInt(log.args[0]),
        provider: String(log.args[1]),
        amount: BigInt(log.args[2]),
      };
    }
  }

  return { jobCompleted, paymentReleased };
}

// ============================================================================
// Contract interaction — real on-chain calls
// ============================================================================

/**
 * Create an ACP contract instance connected to a signer.
 */
export function connectACP(address: string, signer: Signer): Contract {
  return new Contract(address, ACP_ABI, signer);
}

/**
 * Create a job on the AgenticCommerceProtocol.
 * Calls createJob() on-chain and returns the jobId from the event.
 */
export async function createJob(acp: Contract, params: JobParams): Promise<{ jobId: bigint; txHash: string }> {
  const tx = await acp.createJob(params.provider, params.evaluator, params.expiredAt, params.description, params.hook);
  const receipt = await tx.wait();

  // Parse JobCreated event to get jobId
  for (const log of receipt.logs) {
    try {
      const parsed = acp.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "JobCreated") {
        return { jobId: BigInt(parsed.args[0]), txHash: receipt.hash };
      }
    } catch {
      continue;
    }
  }

  throw new Error("JobCreated event not found in receipt");
}

/**
 * Set budget for a job. Client only.
 */
export async function setBudget(acp: Contract, jobId: bigint | number, amount: bigint): Promise<string> {
  const tx = await acp.setBudget(jobId, amount);
  const receipt = await tx.wait();
  return receipt.hash;
}

/**
 * Fund a job (transfer payment token to escrow). Client only.
 * expectedBudget must match current budget to prevent front-running.
 */
export async function fundJob(acp: Contract, jobId: bigint | number, expectedBudget: bigint): Promise<string> {
  const tx = await acp.fund(jobId, expectedBudget);
  const receipt = await tx.wait();
  return receipt.hash;
}

/**
 * Submit a deliverable for a funded job. Provider only.
 */
export async function submitDeliverable(acp: Contract, jobId: bigint | number, deliverable: string): Promise<string> {
  const tx = await acp.submit(jobId, deliverable);
  const receipt = await tx.wait();
  return receipt.hash;
}

/**
 * Complete a job and release payment. Evaluator only.
 */
export async function completeJob(
  acp: Contract,
  jobId: bigint | number,
  reason: string
): Promise<ParsedCompletionEvents & { txHash: string }> {
  const tx = await acp.complete(jobId, reason);
  const receipt = await tx.wait();
  const events = parseJobCompletedEvent(receipt);
  return { ...events, txHash: receipt.hash };
}

/**
 * Reject a job and refund if funded. Client or evaluator.
 */
export async function rejectJob(acp: Contract, jobId: bigint | number, reason: string): Promise<string> {
  const tx = await acp.reject(jobId, reason);
  const receipt = await tx.wait();
  return receipt.hash;
}

/**
 * Claim refund for an expired job. Client only.
 */
export async function claimRefund(acp: Contract, jobId: bigint | number): Promise<string> {
  const tx = await acp.claimRefund(jobId);
  const receipt = await tx.wait();
  return receipt.hash;
}

/**
 * Get job details from the contract.
 */
export async function getJob(
  acp: Contract,
  jobId: bigint | number
): Promise<{
  client: string;
  provider: string;
  evaluator: string;
  budget: bigint;
  expiredAt: bigint;
  status: number;
  description: string;
  deliverable: string;
  hook: string;
}> {
  const job = await acp.getJob(jobId);
  return {
    client: job[0],
    provider: job[1],
    evaluator: job[2],
    budget: BigInt(job[3]),
    expiredAt: BigInt(job[4]),
    status: Number(job[5]),
    description: job[6],
    deliverable: job[7],
    hook: job[8],
  };
}
