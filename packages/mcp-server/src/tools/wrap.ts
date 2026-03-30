// SPDX-License-Identifier: BUSL-1.1

import { Contract, parseUnits, formatUnits } from "ethers";
import type { Wallet } from "ethers";
import { USDC_ABI, TOKEN_ABI, USDC_DECIMALS } from "../config.js";
import type { ChainConfig } from "../config.js";

/**
 * wrap_usdc — Approve USDC + wrap into ConfidentialUSDC (cUSDC).
 *
 * Steps:
 * 1. Approve ConfidentialUSDC contract to spend USDC
 * 2. Call cUSDC.wrap(to, amount)
 *
 * @returns Tool result text with tx hashes and amounts
 */
export async function wrapUsdc(
  wallet: Wallet,
  chain: ChainConfig,
  amount: string
): Promise<string> {
  const { usdcAddress, tokenAddress } = chain.contracts;
  const parsedAmount = parseUnits(amount, USDC_DECIMALS);

  if (parsedAmount <= 0n) {
    throw new Error("Amount must be greater than 0");
  }

  const usdc = new Contract(usdcAddress, USDC_ABI, wallet);
  const token = new Contract(tokenAddress, TOKEN_ABI, wallet);
  const walletAddress = await wallet.getAddress();

  // Step 1: Check allowance and approve if needed
  const currentAllowance: bigint = await usdc.allowance(walletAddress, tokenAddress);
  let approveTxHash = "";

  if (currentAllowance < parsedAmount) {
    const approveTx = await usdc.approve(tokenAddress, parsedAmount);
    const approveReceipt = await approveTx.wait();
    if (!approveReceipt || approveReceipt.status === 0) {
      throw new Error(`USDC approval failed: ${approveTx.hash}`);
    }
    approveTxHash = approveTx.hash;
  }

  // Step 2: Wrap USDC -> cUSDC
  const wrapTx = await token.wrap(walletAddress, parsedAmount);
  const wrapReceipt = await wrapTx.wait();

  if (!wrapReceipt || wrapReceipt.status === 0) {
    throw new Error(`Wrap transaction failed: ${wrapTx.hash}`);
  }

  const lines = [
    `Wrapped ${amount} USDC into cUSDC (ConfidentialUSDC)`,
    "",
    `Amount: ${amount} USDC (${parsedAmount.toString()} raw)`,
    `Wrap TX: ${chain.explorerUrl}/tx/${wrapTx.hash}`,
  ];

  if (approveTxHash) {
    lines.push(`Approve TX: ${chain.explorerUrl}/tx/${approveTxHash}`);
  }

  lines.push(
    "",
    `cUSDC contract: ${tokenAddress}`,
    `Your address: ${walletAddress}`
  );

  return lines.join("\n");
}
