// SPDX-License-Identifier: BUSL-1.1

/**
 * MARC Protocol MCP Server — Chain configuration & contract addresses.
 *
 * Mirrors the SDK's chains.ts but kept self-contained so the MCP server
 * has zero runtime dependency on the SDK package.
 */

// ============================================================================
// Chain Configuration
// ============================================================================

export interface ChainContracts {
  /** ConfidentialUSDC (ERC-7984 token wrapper) */
  tokenAddress: string;
  /** X402PaymentVerifier (nonce registry) */
  verifierAddress: string;
  /** USDC (underlying ERC-20) */
  usdcAddress: string;
  /** AgenticCommerceProtocol (ERC-8183 escrow) */
  acpAddress: string;
  /** AgentIdentityRegistry (ERC-8004) */
  identityAddress: string;
  /** AgentReputationRegistry (ERC-8004) */
  reputationAddress: string;
  /** ConfidentialACP — FHE-encrypted ERC-8183 job escrow */
  confidentialAcpAddress: string;
}

export interface ChainConfig {
  chainId: number;
  name: string;
  network: string;
  rpcUrl: string;
  explorerUrl: string;
  contracts: ChainContracts;
}

/** Sepolia testnet — V4.3 deployed contracts */
const SEPOLIA: ChainConfig = {
  chainId: 11155111,
  name: "Ethereum Sepolia",
  network: "eip155:11155111",
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  explorerUrl: "https://sepolia.etherscan.io",
  contracts: {
    tokenAddress: "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D",
    verifierAddress: "0x4503A7aee235aBD10e6064BBa8E14235fdF041f4",
    usdcAddress: "0xc89e913676B034f8b38E49f7508803d1cDEC9F4f",
    acpAddress: "0xBCA8d5ce6D57f36c7aF71954e9F7f86773a02F22",
    identityAddress: "0xf4609D5DB3153717827703C795acb00867b69567",
    reputationAddress: "0xd1Dd10990f317802c79077834c75742388959668",
    confidentialAcpAddress: "0xC67B36474AA66D1c2E13029d22F93aBa3c5f6708",
  },
};

/** Ethereum mainnet — addresses set after deployment */
const MAINNET: ChainConfig = {
  chainId: 1,
  name: "Ethereum Mainnet",
  network: "eip155:1",
  rpcUrl: "",
  explorerUrl: "https://etherscan.io",
  contracts: {
    tokenAddress: "",
    verifierAddress: "",
    usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    acpAddress: "",
    identityAddress: "",
    reputationAddress: "",
    confidentialAcpAddress: "",
  },
};

export const CHAINS: Record<number, ChainConfig> = {
  11155111: SEPOLIA,
  1: MAINNET,
};

export function getChainConfig(chainId: number): ChainConfig {
  const config = CHAINS[chainId];
  if (!config) {
    throw new Error(`Unsupported chainId: ${chainId}. Supported: ${Object.keys(CHAINS).join(", ")}`);
  }
  return config;
}

// ============================================================================
// Contract ABIs (minimal — only what MCP tools need)
// ============================================================================

/** USDC (standard ERC-20) */
export const USDC_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
] as const;

/** ConfidentialUSDC (ERC-7984 wrapper) */
export const TOKEN_ABI = [
  "function name() external view returns (string)",
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
  "function confidentialBalanceOf(address account) external view returns (bytes32)",
  "function confidentialTransfer(address to, bytes32 encryptedAmount, bytes calldata inputProof) external returns (bytes32)",
  "function wrap(address to, uint256 amount) external",
  "function unwrap(address from, address to, bytes32 encryptedAmount, bytes calldata inputProof) external",
  "function finalizeUnwrap(bytes32 burntAmount, uint64 burntAmountCleartext, bytes calldata decryptionProof) external",
  "function underlying() external view returns (address)",
  "function paused() external view returns (bool)",
  "function setOperator(address operator, uint48 until) external",
  "function isOperator(address holder, address spender) external view returns (bool)",
] as const;

/** X402PaymentVerifier */
export const VERIFIER_ABI = [
  "function recordPayment(address server, bytes32 nonce, uint64 minPrice) external",
  "function usedNonces(bytes32 nonce) external view returns (bool)",
  "function trustedToken() external view returns (address)",
  "function payAndRecord(address token, address server, bytes32 nonce, uint64 minPrice, bytes32 encryptedAmount, bytes calldata inputProof) external",
  "function recordBatchPayment(address server, bytes32 nonce, uint32 requestCount, uint64 pricePerRequest) external",
  "event BatchPaymentRecorded(address indexed payer, address indexed server, bytes32 indexed nonce, uint32 requestCount, uint64 pricePerRequest)",
] as const;

// ============================================================================
// Protocol Constants
// ============================================================================

export const FHE_SCHEME = "fhe-confidential-v1" as const;
export const FEE_BPS = 10n;
export const BPS = 10_000n;
export const MIN_PROTOCOL_FEE = 10_000n;
export const USDC_DECIMALS = 6;

/**
 * Parse USDC amount string to atomic units (6 decimals).
 * String-based to avoid floating-point precision loss.
 */
export function parseUsdcAmount(amount: string): bigint {
  const parts = amount.split(".");
  const intPart = parts[0] || "0";
  const decPart = (parts[1] || "").padEnd(USDC_DECIMALS, "0").slice(0, USDC_DECIMALS);
  return BigInt(intPart) * 1_000_000n + BigInt(decPart);
}
