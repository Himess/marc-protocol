// SPDX-License-Identifier: BUSL-1.1

import {
  FHE_SCHEME,
  FEE_BPS,
  BPS,
  MIN_PROTOCOL_FEE,
  USDC_DECIMALS,
} from "../config.js";
import type { ChainConfig } from "../config.js";

/**
 * protocol_info — Return MARC Protocol configuration and contract addresses.
 *
 * No on-chain calls needed — purely informational.
 *
 * @returns Tool result text with protocol details
 */
export function protocolInfo(chain: ChainConfig, walletAddress: string): string {
  const feePercent = Number(FEE_BPS) / Number(BPS) * 100;
  const minFeeUsdc = Number(MIN_PROTOCOL_FEE) / 1_000_000;

  return [
    `MARC Protocol — FHE Confidential Payment Protocol`,
    `Version: 1.0.0`,
    `Scheme: ${FHE_SCHEME}`,
    "",
    `=== Chain ===`,
    `Network: ${chain.name}`,
    `Chain ID: ${chain.chainId}`,
    `CAIP-2: ${chain.network}`,
    `Explorer: ${chain.explorerUrl}`,
    "",
    `=== Contracts ===`,
    `ConfidentialUSDC (cUSDC): ${chain.contracts.tokenAddress}`,
    `X402PaymentVerifier: ${chain.contracts.verifierAddress}`,
    `USDC (underlying): ${chain.contracts.usdcAddress}`,
    "",
    `=== Fee Structure ===`,
    `Protocol fee: ${feePercent}% (${FEE_BPS} bps)`,
    `Minimum fee: ${minFeeUsdc} USDC (${MIN_PROTOCOL_FEE.toString()} raw)`,
    `Asset decimals: ${USDC_DECIMALS}`,
    "",
    `=== Wallet ===`,
    `Connected address: ${walletAddress}`,
    "",
    `=== How It Works ===`,
    `1. USDC is wrapped into cUSDC (ConfidentialUSDC, ERC-7984)`,
    `2. Transfers use FHE encryption — amounts are encrypted on-chain`,
    `3. x402 payments: server returns 402 → agent encrypts + pays → server verifies on-chain`,
    `4. Only sender and recipient can decrypt transfer amounts`,
    "",
    `=== Available Tools ===`,
    `- wrap_usdc: Convert USDC to cUSDC`,
    `- unwrap_cusdc: Convert cUSDC back to USDC (2-step async)`,
    `- confidential_transfer: Send encrypted cUSDC to any address`,
    `- get_balance: Check USDC and cUSDC balances`,
    `- pay_x402: Access x402-paywalled APIs with automatic FHE payment`,
    `- protocol_info: This info page`,
  ].join("\n");
}
