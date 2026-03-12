/**
 * Silent Failure Guard — Detects potential 0-amount FHE transfers.
 *
 * In FHE, confidentialTransfer() always succeeds even if sender has
 * insufficient balance. The actual transferred amount is encrypted
 * and may decrypt to 0. This module provides heuristic checks to
 * detect likely silent failures.
 *
 * Strategies:
 * 1. Pre-transfer: Check if sender has a non-zero encrypted balance handle
 * 2. Post-transfer: Compare sender's balance handle before/after
 * 3. Event-based: Verify ConfidentialTransfer event handle changed
 *
 * IMPORTANT: These are heuristic checks, not guarantees. The encrypted
 * amount cannot be verified without KMS decryption. For high-value
 * payments, consider requiring the sender to prove their balance via
 * a KMS decryption request.
 */
import { ethers } from "ethers";

const ZERO_HANDLE = "0x" + "00".repeat(32);

const BALANCE_ABI = ["function confidentialBalanceOf(address account) external view returns (bytes32)"];

export interface SilentFailureCheckResult {
  /** Whether the transfer likely succeeded (heuristic, not guaranteed) */
  likelyValid: boolean;
  /** Reason for the check result */
  reason: string;
  /** Sender's encrypted balance handle before transfer (if checked) */
  balanceHandleBefore?: string;
  /** Sender's encrypted balance handle after transfer (if checked) */
  balanceHandleAfter?: string;
}

/**
 * Pre-transfer check: Verify sender has a non-zero encrypted balance.
 * A zero handle means the sender has never received cUSDC.
 */
export async function checkSenderHasBalance(
  tokenAddress: string,
  senderAddress: string,
  provider: ethers.Provider
): Promise<SilentFailureCheckResult> {
  const token = new ethers.Contract(tokenAddress, BALANCE_ABI, provider);
  const handle: string = await token.confidentialBalanceOf(senderAddress);

  if (handle === ZERO_HANDLE) {
    return {
      likelyValid: false,
      reason: "Sender has zero encrypted balance handle — no cUSDC ever received",
      balanceHandleBefore: handle,
    };
  }

  return {
    likelyValid: true,
    reason: "Sender has non-zero encrypted balance handle",
    balanceHandleBefore: handle,
  };
}

/**
 * Post-transfer check: Compare sender's balance handle before and after transfer.
 * If the handle changed, the FHE VM likely updated the balance (transfer > 0).
 * If the handle stayed the same, the transfer was likely 0 (silent failure).
 *
 * CAVEAT: Handle comparison is a heuristic. In some FHE implementations,
 * a 0-transfer may still produce a new handle. This check catches the
 * common case where tryDecrease returns the original handle on failure.
 */
export async function checkBalanceChanged(
  tokenAddress: string,
  senderAddress: string,
  balanceHandleBefore: string,
  provider: ethers.Provider
): Promise<SilentFailureCheckResult> {
  const token = new ethers.Contract(tokenAddress, BALANCE_ABI, provider);
  const handleAfter: string = await token.confidentialBalanceOf(senderAddress);

  if (handleAfter === balanceHandleBefore) {
    return {
      likelyValid: false,
      reason: "Sender balance handle unchanged after transfer — likely 0-amount (silent failure)",
      balanceHandleBefore,
      balanceHandleAfter: handleAfter,
    };
  }

  return {
    likelyValid: true,
    reason: "Sender balance handle changed — transfer likely succeeded",
    balanceHandleBefore,
    balanceHandleAfter: handleAfter,
  };
}

/**
 * Full pre+post transfer verification.
 * Call getBalanceBefore() before the transfer, then verifyAfterTransfer() after.
 */
export async function getBalanceBefore(
  tokenAddress: string,
  senderAddress: string,
  provider: ethers.Provider
): Promise<string> {
  const token = new ethers.Contract(tokenAddress, BALANCE_ABI, provider);
  return await token.confidentialBalanceOf(senderAddress);
}

export async function verifyAfterTransfer(
  tokenAddress: string,
  senderAddress: string,
  balanceBefore: string,
  provider: ethers.Provider
): Promise<SilentFailureCheckResult> {
  // First check: did sender even have a balance?
  if (balanceBefore === ZERO_HANDLE) {
    return {
      likelyValid: false,
      reason: "Sender had zero balance before transfer — guaranteed silent failure",
      balanceHandleBefore: balanceBefore,
    };
  }

  return checkBalanceChanged(tokenAddress, senderAddress, balanceBefore, provider);
}
