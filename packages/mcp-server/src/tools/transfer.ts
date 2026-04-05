// SPDX-License-Identifier: BUSL-1.1

import { Contract, isAddress } from "ethers";
import type { Wallet } from "ethers";
import { TOKEN_ABI, parseUsdcAmount } from "../config.js";
import type { ChainConfig } from "../config.js";

/**
 * FHE encrypted input interface (minimal).
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
 * confidential_transfer — Send cUSDC to another address with FHE encryption.
 *
 * The amount is encrypted client-side using @zama-fhe/relayer-sdk before
 * being sent on-chain. Only the sender and recipient can decrypt the amount.
 *
 * @returns Tool result text with tx hash and transfer details
 */
export async function confidentialTransfer(
  wallet: Wallet,
  chain: ChainConfig,
  to: string,
  amount: string,
  fhevmInstance: FhevmInstance | null
): Promise<string> {
  if (!isAddress(to)) {
    throw new Error(`Invalid recipient address: ${to}`);
  }

  const { tokenAddress } = chain.contracts;
  const walletAddress = await wallet.getAddress();

  // USDC = 6 decimals (string-based, no floating-point)
  const parsedAmount = parseUsdcAmount(amount);

  if (parsedAmount <= 0n) {
    throw new Error("Amount must be greater than 0");
  }

  if (!fhevmInstance) {
    throw new Error(
      "FHE instance not initialized. Set FHEVM_GATEWAY_URL environment variable or ensure @zama-fhe/relayer-sdk is available."
    );
  }

  // Encrypt amount with FHE
  const input = fhevmInstance.createEncryptedInput(tokenAddress, walletAddress);
  input.add64(parsedAmount);

  const encrypted = await Promise.race([
    input.encrypt(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("FHE encryption timed out after 30s")), 30_000)
    ),
  ]);

  if (!encrypted.handles || encrypted.handles.length === 0) {
    throw new Error("FHE encryption returned no handles");
  }

  // Call confidentialTransfer on cUSDC
  const token = new Contract(tokenAddress, TOKEN_ABI, wallet);

  const tx = await token.confidentialTransfer(to, encrypted.handles[0], encrypted.inputProof);
  const receipt = await tx.wait();

  if (!receipt || receipt.status === 0) {
    throw new Error(`Confidential transfer failed: ${tx.hash}`);
  }

  return [
    `Confidential transfer sent`,
    "",
    `Amount: ${amount} cUSDC (encrypted on-chain)`,
    `From: ${walletAddress}`,
    `To: ${to}`,
    `TX: ${chain.explorerUrl}/tx/${tx.hash}`,
    "",
    `The transfer amount is FHE-encrypted — only sender and recipient can decrypt it.`,
    `cUSDC contract: ${tokenAddress}`,
  ].join("\n");
}
