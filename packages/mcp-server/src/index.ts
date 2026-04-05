// SPDX-License-Identifier: BUSL-1.1

/**
 * MARC Protocol MCP Server
 *
 * Model Context Protocol server that exposes FHE confidential payment tools
 * to AI agents (Claude, ChatGPT, Gemini, etc.).
 *
 * Environment variables:
 *   PRIVATE_KEY  — Wallet private key (hex, with or without 0x prefix)
 *   CHAIN_ID     — Chain ID (default: 11155111 for Sepolia)
 *   RPC_URL      — RPC endpoint (overrides chain default)
 *
 * Usage:
 *   PRIVATE_KEY=0x... node dist/index.js
 *
 * Claude Desktop config:
 *   {
 *     "mcpServers": {
 *       "marc-protocol": {
 *         "command": "npx",
 *         "args": ["@marc-protocol/mcp-server"],
 *         "env": { "PRIVATE_KEY": "0x..." }
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { JsonRpcProvider, Wallet } from "ethers";

import { getChainConfig } from "./config.js";
import type { ChainConfig } from "./config.js";
import { wrapUsdc } from "./tools/wrap.js";
import { unwrapCusdc } from "./tools/unwrap.js";
import { confidentialTransfer } from "./tools/transfer.js";
import { getBalance } from "./tools/balance.js";
import { payX402 } from "./tools/pay.js";
import { protocolInfo } from "./tools/info.js";

// ============================================================================
// FHE Instance (lazy-loaded)
// ============================================================================

interface FhevmInstance {
  createEncryptedInput: (
    contractAddress: string,
    userAddress: string
  ) => {
    add64: (value: bigint | number) => void;
    addAddress: (value: string) => void;
    encrypt: () => Promise<{ handles: string[]; inputProof: string }>;
  };
}

let _fhevmInstance: FhevmInstance | null = null;
let _fheInitPromise: Promise<FhevmInstance | null> | null = null;

async function getFhevmInstance(): Promise<FhevmInstance | null> {
  if (_fhevmInstance) return _fhevmInstance;
  if (_fheInitPromise) return _fheInitPromise;

  _fheInitPromise = (async () => {
    try {
      // Dynamic import via variable to avoid TS module resolution at build time.
      // @zama-fhe/relayer-sdk is a peer dependency — only loaded if installed.
      const moduleName = "@zama-fhe/relayer-sdk";
      const mod = await import(/* webpackIgnore: true */ moduleName) as {
        createInstance: (opts: { gatewayUrl: string; chainId: number }) => Promise<unknown>;
      };
      const gatewayUrl = process.env.FHEVM_GATEWAY_URL || "https://gateway.zama.ai";
      _fhevmInstance = await mod.createInstance({
        gatewayUrl,
        chainId: parseInt(process.env.CHAIN_ID || "11155111", 10),
      }) as FhevmInstance;
      return _fhevmInstance;
    } catch {
      // @zama-fhe/relayer-sdk not available — FHE tools will error with clear message
      return null;
    }
  })();

  return _fheInitPromise;
}

// ============================================================================
// Tool Result Helper
// ============================================================================

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Read environment
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    process.stderr.write(
      "MARC MCP Server: PRIVATE_KEY environment variable is required.\n" +
        "Set it in your MCP client config or shell environment.\n"
    );
    process.exit(1);
  }

  // Validate PRIVATE_KEY format
  const normalizedKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const hexPart = normalizedKey.slice(2);
  if (!/^[0-9a-fA-F]+$/.test(hexPart)) {
    process.stderr.write(
      "MARC MCP Server: PRIVATE_KEY contains invalid hex characters.\n" +
        "Expected a 32-byte hex string (64 hex chars), with or without 0x prefix.\n"
    );
    process.exit(1);
  }
  if (hexPart.length !== 64) {
    process.stderr.write(
      `MARC MCP Server: PRIVATE_KEY has invalid length (${hexPart.length} hex chars, expected 64).\n` +
        "A valid private key is 32 bytes = 64 hex characters, with or without 0x prefix.\n"
    );
    process.exit(1);
  }

  const chainId = parseInt(process.env.CHAIN_ID || "11155111", 10);
  let chain: ChainConfig;
  try {
    chain = getChainConfig(chainId);
  } catch (err) {
    process.stderr.write(`MARC MCP Server: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const rpcUrl = process.env.RPC_URL || chain.rpcUrl;
  if (!rpcUrl) {
    process.stderr.write(
      `MARC MCP Server: No RPC URL for chain ${chainId}. Set RPC_URL environment variable.\n`
    );
    process.exit(1);
  }

  // Initialize wallet
  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(privateKey, provider);
  const walletAddress = await wallet.getAddress();

  process.stderr.write(
    `MARC MCP Server v1.0.0\n` +
      `  Chain: ${chain.name} (${chainId})\n` +
      `  Wallet: ${walletAddress}\n` +
      `  RPC: ${rpcUrl}\n`
  );

  // Create MCP server
  const server = new McpServer({
    name: "marc-protocol",
    version: "1.0.0",
  });

  // ========================================================================
  // Tool: wrap_usdc
  // ========================================================================
  server.registerTool(
    "wrap_usdc",
    {
      title: "Wrap USDC",
      description:
        "Wrap USDC into ConfidentialUSDC (cUSDC). Approves the cUSDC contract to spend your USDC, " +
        "then wraps the specified amount. The cUSDC tokens can be used for confidential (FHE-encrypted) transfers.",
      inputSchema: {
        amount: z
          .string()
          .describe('USDC amount to wrap (e.g. "1.50" for 1.50 USDC)'),
      },
    },
    async ({ amount }) => {
      try {
        const result = await wrapUsdc(wallet, chain, amount);
        return textResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ========================================================================
  // Tool: unwrap_cusdc
  // ========================================================================
  server.registerTool(
    "unwrap_cusdc",
    {
      title: "Unwrap cUSDC",
      description:
        "Initiate unwrap of ConfidentialUSDC (cUSDC) back to USDC. " +
        "This is a 2-step async process: (1) submit encrypted amount for decryption via Zama Gateway, " +
        "(2) finalize after Gateway decrypts. This tool performs step 1 only.",
      inputSchema: {
        amount: z
          .string()
          .describe('cUSDC amount to unwrap (e.g. "1.50" for 1.50 cUSDC)'),
      },
    },
    async ({ amount }) => {
      try {
        const fhevm = await getFhevmInstance();
        const result = await unwrapCusdc(wallet, chain, amount, fhevm);
        return textResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ========================================================================
  // Tool: confidential_transfer
  // ========================================================================
  server.registerTool(
    "confidential_transfer",
    {
      title: "Confidential Transfer",
      description:
        "Send cUSDC to another address with FHE encryption. " +
        "The transfer amount is encrypted on-chain — only sender and recipient can see it. " +
        "Requires cUSDC balance (use wrap_usdc first if needed).",
      inputSchema: {
        to: z
          .string()
          .describe("Recipient Ethereum address (0x...)"),
        amount: z
          .string()
          .describe('USDC amount to transfer (e.g. "1.50" for 1.50 USDC)'),
      },
    },
    async ({ to, amount }) => {
      try {
        const fhevm = await getFhevmInstance();
        const result = await confidentialTransfer(wallet, chain, to, amount, fhevm);
        return textResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ========================================================================
  // Tool: get_balance
  // ========================================================================
  server.registerTool(
    "get_balance",
    {
      title: "Get Balance",
      description:
        "Check USDC and cUSDC (ConfidentialUSDC) balances for an address. " +
        "USDC balance is cleartext. cUSDC balance is FHE-encrypted (returns handle, not amount). " +
        "Defaults to the connected wallet if no address specified.",
      inputSchema: {
        address: z
          .string()
          .optional()
          .describe("Ethereum address to check (defaults to connected wallet)"),
      },
    },
    async ({ address }) => {
      try {
        const result = await getBalance(wallet, chain, address);
        return textResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ========================================================================
  // Tool: pay_x402
  // ========================================================================
  server.registerTool(
    "pay_x402",
    {
      title: "Pay x402",
      description:
        "Access an x402-paywalled API with automatic FHE payment. " +
        "Fetches the URL, handles 402 payment response, encrypts amount with FHE, " +
        "pays the server via cUSDC confidential transfer, records nonce on-chain, " +
        "and retries with payment proof. Returns the API response.",
      inputSchema: {
        url: z
          .string()
          .url()
          .describe("The x402-protected API URL to access"),
        method: z
          .string()
          .default("GET")
          .describe('HTTP method (default: "GET")'),
      },
    },
    async ({ url, method }) => {
      try {
        const fhevm = await getFhevmInstance();
        const result = await payX402(wallet, chain, url, method, fhevm);
        return textResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ========================================================================
  // Tool: protocol_info
  // ========================================================================
  server.registerTool(
    "protocol_info",
    {
      title: "Protocol Info",
      description:
        "Get MARC Protocol configuration: contract addresses, chain info, fee structure, " +
        "connected wallet, and available tools. No on-chain calls needed.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = protocolInfo(chain, walletAddress);
        return textResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ========================================================================
  // Connect via stdio
  // ========================================================================
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write("MARC MCP Server connected via stdio.\n");
}

main().catch((err) => {
  process.stderr.write(`MARC MCP Server fatal error: ${err}\n`);
  process.exit(1);
});
