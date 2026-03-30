// SPDX-License-Identifier: BUSL-1.1

import { Contract, formatUnits, isAddress } from "ethers";
import type { Wallet } from "ethers";
import { USDC_ABI, TOKEN_ABI, USDC_DECIMALS } from "../config.js";
import type { ChainConfig } from "../config.js";

/**
 * get_balance — Query USDC and cUSDC balances for an address.
 *
 * Returns:
 * - USDC balance (cleartext ERC-20)
 * - cUSDC balance handle (encrypted — returns the bytes32 handle, not the decrypted value)
 *
 * @returns Tool result text with balance information
 */
export async function getBalance(
  wallet: Wallet,
  chain: ChainConfig,
  address?: string
): Promise<string> {
  const targetAddress = address || (await wallet.getAddress());

  if (!isAddress(targetAddress)) {
    throw new Error(`Invalid address: ${targetAddress}`);
  }

  const { usdcAddress, tokenAddress } = chain.contracts;

  const usdc = new Contract(usdcAddress, USDC_ABI, wallet);
  const token = new Contract(tokenAddress, TOKEN_ABI, wallet);

  // Fetch balances in parallel
  const [usdcBalance, cUsdcHandle] = await Promise.all([
    usdc.balanceOf(targetAddress) as Promise<bigint>,
    token.confidentialBalanceOf(targetAddress) as Promise<string>,
  ]);

  const formattedUsdc = formatUnits(usdcBalance, USDC_DECIMALS);

  // Check if cUSDC handle is zero (no balance)
  const zeroHandle = "0x" + "00".repeat(32);
  const hasEncryptedBalance = cUsdcHandle !== zeroHandle;

  return [
    `Balances for ${targetAddress}`,
    `Chain: ${chain.name} (${chain.chainId})`,
    "",
    `USDC (cleartext): ${formattedUsdc} USDC`,
    `cUSDC (encrypted): ${hasEncryptedBalance ? "Has encrypted balance" : "0 (no encrypted balance)"}`,
    `  Handle: ${cUsdcHandle}`,
    "",
    `USDC contract: ${usdcAddress}`,
    `cUSDC contract: ${tokenAddress}`,
    "",
    hasEncryptedBalance
      ? "Note: The cUSDC balance is FHE-encrypted. The exact amount can only be decrypted by the owner using Zama's Gateway."
      : "Tip: Use wrap_usdc to convert USDC into cUSDC for confidential transfers.",
  ].join("\n");
}
