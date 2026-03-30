// SPDX-License-Identifier: BUSL-1.1

import { Contract } from "ethers";
import type { Wallet } from "ethers";
import { TOKEN_ABI, parseUsdcAmount } from "../config.js";
import type { ChainConfig } from "../config.js";

/**
 * FHE encrypted input interface (minimal — matches @zama-fhe/relayer-sdk).
 */
interface FhevmInstance {
  createEncryptedInput: (
    contractAddress: string,
    userAddress: string
  ) => {
    add64: (value: bigint | number) => void;
    encrypt: () => Promise<{ handles: string[]; inputProof: string }>;
  };
}

/**
 * unwrap_cusdc — Initiate unwrap of cUSDC back to USDC.
 *
 * This is a 2-step async process on Zama's FHEVM:
 * 1. Call cUSDC.unwrap() — submits encrypted amount for decryption
 * 2. After the Zama Gateway decrypts, call cUSDC.finalizeUnwrap()
 *    (this step is NOT done here — it requires waiting for decryption callback)
 *
 * @returns Tool result text with tx hash and instructions
 */
export async function unwrapCusdc(
  wallet: Wallet,
  chain: ChainConfig,
  amount: string,
  fhevmInstance: FhevmInstance | null
): Promise<string> {
  const { tokenAddress } = chain.contracts;
  const walletAddress = await wallet.getAddress();

  // Parse amount: USDC uses 6 decimals (string-based, no floating-point)
  const parsedAmount = parseUsdcAmount(amount);

  if (parsedAmount <= 0n) {
    throw new Error("Amount must be greater than 0");
  }

  if (!fhevmInstance) {
    throw new Error(
      "FHE instance not initialized. Set FHEVM_GATEWAY_URL environment variable or ensure @zama-fhe/relayer-sdk is available."
    );
  }

  // Encrypt the amount for the unwrap call
  const input = fhevmInstance.createEncryptedInput(tokenAddress, walletAddress);
  input.add64(parsedAmount);
  const encrypted = await input.encrypt();

  if (!encrypted.handles || encrypted.handles.length === 0) {
    throw new Error("FHE encryption returned no handles");
  }

  const token = new Contract(tokenAddress, TOKEN_ABI, wallet);

  // Call unwrap — initiates async decryption via Zama Gateway
  const tx = await token.unwrap(
    walletAddress,
    walletAddress,
    encrypted.handles[0],
    encrypted.inputProof
  );
  const receipt = await tx.wait();

  if (!receipt || receipt.status === 0) {
    throw new Error(`Unwrap transaction failed: ${tx.hash}`);
  }

  return [
    `Unwrap initiated for ${amount} cUSDC`,
    "",
    `This is a 2-step process:`,
    `1. unwrap() submitted (this TX) — encrypted amount sent to Zama Gateway for decryption`,
    `2. finalizeUnwrap() — must be called after the Gateway decrypts the amount`,
    "",
    `Step 1 TX: ${chain.explorerUrl}/tx/${tx.hash}`,
    `Amount: ${amount} cUSDC (${parsedAmount.toString()} raw)`,
    `cUSDC contract: ${tokenAddress}`,
    `Your address: ${walletAddress}`,
    "",
    `Note: The Gateway typically takes 1-5 minutes to process the decryption.`,
    `After that, call finalizeUnwrap() to receive your USDC.`,
  ].join("\n");
}
