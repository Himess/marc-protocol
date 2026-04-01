# MARC Protocol — Plugin Development Guide

Build your own framework integration for MARC Protocol.

## Overview

MARC Protocol supports any agent payment framework through plugins. A plugin wraps the core SDK operations (wrap, transfer, pay, unwrap, balance) into the target framework's interface.

## Existing Plugins

| Plugin | Framework | Package |
|--------|-----------|---------|
| x402 Scheme | HTTP 402 standard | @marc-protocol/x402-scheme |
| MCP Server | Model Context Protocol | @marc-protocol/mcp-server |
| MPP Method | Machine-Payable Pages | @marc-protocol/mpp-method |
| AgentKit | Coinbase AgentKit | @marc-protocol/agentkit |
| Virtuals GAME | Virtuals Protocol | @fhe-x402/virtuals-plugin |
| OpenClaw | OpenClaw Framework | @fhe-x402/openclaw-skill |

## Architecture

Every plugin follows the same pattern:

```
[Agent Framework] → [Your Plugin] → [MARC SDK] → [Sepolia/Mainnet]
```

Your plugin translates framework-specific calls into SDK calls.

## Step-by-Step Guide

### 1. Create Package Structure

```
packages/your-plugin/
  src/
    index.ts          # Main exports
    actions.ts        # Framework-specific action handlers
    config.ts         # Contract addresses (import from SDK)
  tests/
    index.test.ts     # Tests
  package.json
  tsconfig.json
```

### 2. Define Your Actions

Every plugin should expose these 5 core actions:

```typescript
import { ethers } from "ethers";

// 1. Wrap USDC to cUSDC
async function wrap(signer: ethers.Signer, amount: string): Promise<string> {
  // Approve USDC spending
  // Call ConfidentialUSDC.wrap(to, amount)
  // Return tx hash
}

// 2. Encrypted transfer
async function transfer(signer: ethers.Signer, to: string, amount: string): Promise<string> {
  // Encrypt amount with fhEVM relayer
  // Call ConfidentialUSDC.confidentialTransfer(to, encAmount, proof)
  // Return tx hash
}

// 3. Make x402 payment (transfer + record nonce)
async function pay(signer: ethers.Signer, server: string, amount: string): Promise<string> {
  // Transfer encrypted cUSDC to server
  // Record payment nonce on X402PaymentVerifier
  // Return tx hash
}

// 4. Unwrap cUSDC to USDC
async function unwrap(signer: ethers.Signer, amount: string): Promise<string> {
  // Call ConfidentialUSDC.unwrap (2-step: request + finalize)
  // Return request tx hash
}

// 5. Check balances
async function balance(provider: ethers.Provider, address: string): Promise<{usdc: string, cusdc: string}> {
  // Read USDC.balanceOf
  // Read ConfidentialUSDC.confidentialBalanceOf (returns encrypted handle)
  // Return both
}
```

### 3. Import from SDK

Use the SDK as the single source of truth for ABIs and addresses:

```typescript
import {
  TOKEN_ABI,
  VERIFIER_ABI,
  USDC_ABI,
  getChainConfig,
} from "marc-protocol-sdk";

const config = getChainConfig(11155111); // Sepolia
const tokenAddress = config.tokenAddress;
const verifierAddress = config.verifierAddress;
```

### 4. Handle FHE Encryption

For encrypted transfers, use the Zama fhEVM relayer SDK:

```typescript
import { createInstance } from "@zama-fhe/relayer-sdk";

const fhevmInstance = await createInstance({
  chainId: 11155111,
  networkUrl: "https://ethereum-sepolia-rpc.publicnode.com",
});

const input = fhevmInstance.createEncryptedInput(tokenAddress, signerAddress);
input.add64(amountInMicroUSDC);
const { handles, inputProof } = input.encrypt();
```

### 5. Write Tests

Follow the existing test patterns:

```typescript
import { describe, it, expect, vi } from "vitest";

describe("YourPlugin", () => {
  it("wraps USDC to cUSDC", async () => {
    // Mock signer and contract calls
    // Call your wrap function
    // Assert correct contract interactions
  });

  it("handles insufficient balance", async () => {
    // Test error cases
  });

  it("returns correct balance format", async () => {
    // Test balance parsing
  });
});
```

### 6. Package Configuration

```json
{
  "name": "@marc-protocol/your-plugin",
  "version": "4.3.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "license": "BUSL-1.1",
  "peerDependencies": {
    "marc-protocol-sdk": "^4.3.0",
    "ethers": "^6.0.0"
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm,cjs --dts",
    "test": "vitest run"
  }
}
```

### 7. Submit

1. Follow the contribution guide (CONTRIBUTING.md)
2. Place your plugin in `packages/your-plugin/`
3. Add tests (aim for 80%+ coverage)
4. Update README.md with your plugin listing
5. Open a PR

## Contract Addresses

Always import from SDK. Never hardcode addresses.

| Network | Chain ID |
|---------|----------|
| Sepolia | 11155111 |
| Mainnet | 1 (planned) |
| Base | 8453 (planned) |
| Arbitrum | 42161 (planned) |

## Questions?

Open an issue on GitHub: https://github.com/marc-protocol/marc/issues
