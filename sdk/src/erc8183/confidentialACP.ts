/**
 * ConfidentialACP — ERC-8183 Agentic Commerce with FHE-Encrypted Payments.
 * SDK helpers for interacting with the ConfidentialACP contract,
 * which uses FHE-encrypted cUSDC (ERC-7984) for private job escrow.
 *
 * Unlike the plaintext ACP, budgets are encrypted on-chain via Zama FHE —
 * nobody can see how much a job pays until decrypted by authorized parties.
 */

import { Contract, ethers } from "ethers";
import type { Signer, Provider, ContractTransactionReceipt } from "ethers";
import { CONFIDENTIAL_ACP_ABI, CONFIDENTIAL_ACP_ADDRESS } from "../types.js";

// ============================================================================
// Types
// ============================================================================

/** Job status enum matching the on-chain ConfidentialACP.JobStatus */
export enum ConfidentialJobStatus {
  Open = 0,
  Funded = 1,
  Submitted = 2,
  Completed = 3,
  Rejected = 4,
  Expired = 5,
}

/** Parsed job data from getJob() */
export interface ConfidentialJobData {
  client: string;
  provider: string;
  evaluator: string;
  description: string;
  expiredAt: bigint;
  status: ConfidentialJobStatus;
  hook: string;
  deliverable: string;
}

/** Parsed JobCreated event */
export interface ConfidentialJobCreatedData {
  jobId: bigint;
  client: string;
  provider: string;
  evaluator: string;
  expiredAt: bigint;
}

/** Parsed completion events */
export interface ConfidentialCompletionEvents {
  jobCompleted: { jobId: bigint; evaluator: string; reason: string } | null;
  paymentReleased: { jobId: bigint; provider: string } | null;
}

// ============================================================================
// Contract connection
// ============================================================================

/**
 * Create a ConfidentialACP contract instance connected to a signer or provider.
 * Uses the default deployed address unless overridden.
 */
export function connectConfidentialACP(
  signerOrProvider: Signer | Provider,
  address: string = CONFIDENTIAL_ACP_ADDRESS
): Contract {
  return new Contract(address, CONFIDENTIAL_ACP_ABI, signerOrProvider);
}

// ============================================================================
// Job lifecycle — write operations
// ============================================================================

/**
 * Create a new confidential job on the ConfidentialACP contract.
 * Returns the jobId from the JobCreated event.
 *
 * @param signer - Wallet/signer (the client)
 * @param provider - Address of the work provider
 * @param evaluator - Address of the evaluator who approves/rejects
 * @param expiry - Unix timestamp after which client can claim refund
 * @param description - Human-readable job description
 * @param hook - Optional IACPHook contract address (zero address for none)
 * @param contractAddress - Override deployed address
 */
export async function createConfidentialJob(
  signer: Signer,
  provider: string,
  evaluator: string,
  expiry: number,
  description: string,
  hook: string = ethers.ZeroAddress,
  contractAddress: string = CONFIDENTIAL_ACP_ADDRESS
): Promise<{ jobId: bigint; txHash: string }> {
  const acp = connectConfidentialACP(signer, contractAddress);
  const tx = await acp.createJob(provider, evaluator, expiry, description, hook);
  const receipt: ContractTransactionReceipt = await tx.wait();

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
 * Fund a confidential job with encrypted cUSDC.
 * The amount is encrypted on-chain via FHE — nobody sees the budget.
 *
 * Prerequisites:
 * - Client must have called setOperator(ConfidentialACP, ...) on cUSDC
 * - Client must have sufficient cUSDC balance
 *
 * @param signer - Wallet/signer (the client)
 * @param jobId - Job ID to fund
 * @param amount - Budget amount in cUSDC (uint64, e.g. 100_000_000 = 100 USDC)
 * @param contractAddress - Override deployed address
 */
export async function fundConfidentialJob(
  signer: Signer,
  jobId: bigint | number,
  amount: number | bigint,
  contractAddress: string = CONFIDENTIAL_ACP_ADDRESS
): Promise<string> {
  const acp = connectConfidentialACP(signer, contractAddress);
  const tx = await acp.fund(jobId, amount);
  const receipt: ContractTransactionReceipt = await tx.wait();
  return receipt.hash;
}

/**
 * Submit a deliverable hash for a funded confidential job. Provider only.
 *
 * @param signer - Wallet/signer (the provider)
 * @param jobId - Job ID
 * @param deliverableHash - bytes32 hash of the deliverable (e.g. IPFS CID hash)
 * @param contractAddress - Override deployed address
 */
export async function submitDeliverable(
  signer: Signer,
  jobId: bigint | number,
  deliverableHash: string,
  contractAddress: string = CONFIDENTIAL_ACP_ADDRESS
): Promise<string> {
  const acp = connectConfidentialACP(signer, contractAddress);
  const tx = await acp.submit(jobId, deliverableHash);
  const receipt: ContractTransactionReceipt = await tx.wait();
  return receipt.hash;
}

/**
 * Complete a confidential job and release FHE-encrypted payment. Evaluator only.
 * Platform fee (1%) is calculated using FHE arithmetic — neither fee nor payout is visible.
 *
 * @param signer - Wallet/signer (the evaluator)
 * @param jobId - Job ID
 * @param reasonHash - bytes32 hash of the completion reason
 * @param contractAddress - Override deployed address
 */
export async function completeJob(
  signer: Signer,
  jobId: bigint | number,
  reasonHash: string,
  contractAddress: string = CONFIDENTIAL_ACP_ADDRESS
): Promise<ConfidentialCompletionEvents & { txHash: string }> {
  const acp = connectConfidentialACP(signer, contractAddress);
  const tx = await acp.complete(jobId, reasonHash);
  const receipt: ContractTransactionReceipt = await tx.wait();

  let jobCompleted: ConfidentialCompletionEvents["jobCompleted"] = null;
  let paymentReleased: ConfidentialCompletionEvents["paymentReleased"] = null;

  for (const log of receipt.logs) {
    try {
      const parsed = acp.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "JobCompleted") {
        jobCompleted = {
          jobId: BigInt(parsed.args[0]),
          evaluator: String(parsed.args[1]),
          reason: String(parsed.args[2]),
        };
      }
      if (parsed?.name === "PaymentReleased") {
        paymentReleased = {
          jobId: BigInt(parsed.args[0]),
          provider: String(parsed.args[1]),
        };
      }
    } catch {
      continue;
    }
  }

  return { jobCompleted, paymentReleased, txHash: receipt.hash };
}

/**
 * Reject a confidential job and refund encrypted cUSDC to client.
 * Client can reject Open or Funded jobs. Evaluator can reject Funded or Submitted jobs.
 *
 * @param signer - Wallet/signer (client or evaluator)
 * @param jobId - Job ID
 * @param reasonHash - bytes32 hash of the rejection reason
 * @param contractAddress - Override deployed address
 */
export async function rejectJob(
  signer: Signer,
  jobId: bigint | number,
  reasonHash: string,
  contractAddress: string = CONFIDENTIAL_ACP_ADDRESS
): Promise<string> {
  const acp = connectConfidentialACP(signer, contractAddress);
  const tx = await acp.reject(jobId, reasonHash);
  const receipt: ContractTransactionReceipt = await tx.wait();
  return receipt.hash;
}

/**
 * Claim a refund for an expired funded confidential job. Client only.
 *
 * @param signer - Wallet/signer (the client)
 * @param jobId - Job ID
 * @param contractAddress - Override deployed address
 */
export async function claimRefund(
  signer: Signer,
  jobId: bigint | number,
  contractAddress: string = CONFIDENTIAL_ACP_ADDRESS
): Promise<string> {
  const acp = connectConfidentialACP(signer, contractAddress);
  const tx = await acp.claimRefund(jobId);
  const receipt: ContractTransactionReceipt = await tx.wait();
  return receipt.hash;
}

// ============================================================================
// Job lifecycle — read operations
// ============================================================================

/**
 * Get confidential job details from the contract.
 * Note: budget is FHE-encrypted and not returned by getJob().
 * Use getJobBudget() separately with Zama KMS decryption.
 *
 * @param provider - JSON-RPC provider or signer
 * @param jobId - Job ID to query
 * @param contractAddress - Override deployed address
 */
export async function getConfidentialJob(
  provider: Provider | Signer,
  jobId: bigint | number,
  contractAddress: string = CONFIDENTIAL_ACP_ADDRESS
): Promise<ConfidentialJobData> {
  const acp = connectConfidentialACP(provider, contractAddress);
  const job = await acp.getJob(jobId);
  return {
    client: job[0],
    provider: job[1],
    evaluator: job[2],
    description: job[3],
    expiredAt: BigInt(job[4]),
    status: Number(job[5]) as ConfidentialJobStatus,
    hook: job[6],
    deliverable: job[7],
  };
}

/**
 * Get the total number of confidential jobs created.
 *
 * @param provider - JSON-RPC provider or signer
 * @param contractAddress - Override deployed address
 */
export async function getTotalConfidentialJobs(
  provider: Provider | Signer,
  contractAddress: string = CONFIDENTIAL_ACP_ADDRESS
): Promise<bigint> {
  const acp = connectConfidentialACP(provider, contractAddress);
  return BigInt(await acp.totalJobs());
}

/**
 * Get the encrypted budget handle for a job.
 * The returned value is an FHE ciphertext handle — only the client and provider
 * can decrypt it via Zama KMS.
 *
 * @param provider - JSON-RPC provider or signer
 * @param jobId - Job ID
 * @param contractAddress - Override deployed address
 */
export async function getJobBudget(
  provider: Provider | Signer,
  jobId: bigint | number,
  contractAddress: string = CONFIDENTIAL_ACP_ADDRESS
): Promise<string> {
  const acp = connectConfidentialACP(provider, contractAddress);
  return await acp.getJobBudget(jobId);
}
