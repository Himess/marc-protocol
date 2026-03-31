/**
 * MARC Protocol — Multi-chain contract addresses & configuration.
 *
 * Usage:
 *   import { CHAINS, getChainConfig } from "marc-protocol-sdk";
 *   const config = getChainConfig(1); // Ethereum mainnet
 *   const { tokenAddress, verifierAddress } = config.contracts;
 */

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
  network: string; // CAIP-2 format
  rpcUrl: string;
  explorerUrl: string;
  contracts: ChainContracts;
}

// Sepolia testnet (deployed V4.3)
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

// Ethereum mainnet (addresses set after deployment)
const MAINNET: ChainConfig = {
  chainId: 1,
  name: "Ethereum Mainnet",
  network: "eip155:1",
  rpcUrl: "", // User must provide their own RPC
  explorerUrl: "https://etherscan.io",
  contracts: {
    tokenAddress: "", // Set after mainnet deploy
    verifierAddress: "",
    usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    acpAddress: "",
    identityAddress: "",
    reputationAddress: "",
    confidentialAcpAddress: "",
  },
};

// Base L2 (future — Zama coprocessor planned H1 2026)
const BASE: ChainConfig = {
  chainId: 8453,
  name: "Base",
  network: "eip155:8453",
  rpcUrl: "", // User must provide their own RPC
  explorerUrl: "https://basescan.org",
  contracts: {
    tokenAddress: "", // Set after Base deploy
    verifierAddress: "",
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base native USDC
    acpAddress: "",
    identityAddress: "",
    reputationAddress: "",
    confidentialAcpAddress: "",
  },
};

// Arbitrum L2 (future — Zama coprocessor planned H1 2026)
const ARBITRUM: ChainConfig = {
  chainId: 42161,
  name: "Arbitrum One",
  network: "eip155:42161",
  rpcUrl: "", // User must provide their own RPC
  explorerUrl: "https://arbiscan.io",
  contracts: {
    tokenAddress: "", // Set after Arbitrum deploy
    verifierAddress: "",
    usdcAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Arbitrum native USDC
    acpAddress: "",
    identityAddress: "",
    reputationAddress: "",
  },
};

export const CHAINS: Record<number, ChainConfig> = {
  11155111: SEPOLIA,
  1: MAINNET,
  8453: BASE,
  42161: ARBITRUM,
};

/**
 * Get chain configuration by chainId.
 * @throws if chainId is not supported
 */
export function getChainConfig(chainId: number): ChainConfig {
  const config = CHAINS[chainId];
  if (!config) {
    throw new Error(`Unsupported chainId: ${chainId}. Supported: ${Object.keys(CHAINS).join(", ")}`);
  }
  return config;
}

/**
 * Update mainnet contract addresses after deployment.
 * Call this once after deploying to mainnet.
 */
export function setChainContracts(chainId: number, contracts: Partial<ChainContracts>): void {
  const config = CHAINS[chainId];
  if (!config) {
    throw new Error(`Unsupported chainId: ${chainId}`);
  }
  Object.assign(config.contracts, contracts);
}
