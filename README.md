# FHE x402 — Confidential Payment Protocol for AI Agents

![Tests](https://img.shields.io/badge/tests-217-brightgreen)
![License](https://img.shields.io/badge/license-BUSL--1.1-blue)
![Chain](https://img.shields.io/badge/chain-Ethereum%20Sepolia-purple)

## Overview

FHE x402 is a privacy-preserving HTTP payment protocol that enables AI agents to pay for API access with encrypted USDC amounts on Ethereum. Built on Zama's fhEVM and the x402 payment standard, it uses Fully Homomorphic Encryption to hide payment amounts on-chain while keeping sender and recipient addresses public (as required by x402). Servers verify payments through on-chain events without ever seeing the actual amounts transferred.

**Scheme:** `fhe-confidential-v1` | **Chain:** Ethereum Sepolia (11155111) | **Tests:** 217 (78 contract + 84 SDK + 30 Virtuals + 25 OpenClaw)

> *"Crypto privacy is needed if you want to make API calls without compromising the information of your access patterns. Even with a local AI agent, you can learn a lot about what someone is doing if you see all of their search engine calls. [...] providers will demand an anti-DoS mechanism, and realistically payment per call. By default that will be credit card or some corposlop stablecoin thing — so we need crypto privacy."*
>
> — [Vitalik Buterin, March 2026](https://x.com/VitalikButerin/status/2030510783134871594)

## Architecture

```
Client (Agent A)                          Server (Agent B)
    |                                          |
    |-- GET /api/data ----------------------->|
    |<--- 402 + FhePaymentRequired ------------|
    |                                          |
    |  1. fhevmjs.encrypt(amount)              |
    |  2. cUSDC.confidentialTransfer(to, enc)  |
    |  3. verifier.recordPayment(              |
    |       payer, server, nonce, minPrice)    |
    |                                          |
    |-- Retry + Payment header -------------->|
    |   [Server verifies:                      |
    |    - ConfidentialTransfer event           |
    |    - PaymentVerified event (minPrice)]   |
    |<--- 200 + data -------------------------|
```

**Two contracts — no pool:**

| Contract | Purpose |
|----------|---------|
| **ConfidentialUSDC** | ERC-7984 token wrapper. USDC wraps to encrypted cUSDC. Agents hold cUSDC directly and transfer it peer-to-peer. |
| **X402PaymentVerifier** | Thin nonce registry. Records payment nonces with `minPrice` for server-side price verification. |

## Features

- **Token-centric** — No pool contract. Agents hold encrypted cUSDC in their own wallets.
- **Fee-free transfers** — `confidentialTransfer()` between agents costs zero protocol fee.
- **Fees on wrap/unwrap only** — 0.1% (min 0.01 USDC) charged when entering or exiting the encrypted domain.
- **minPrice verification** — `recordPayment` includes `minPrice` so servers can verify the committed payment amount.
- **ERC-7984 compliant** — Standard confidential token interface (balanceOf, transfer, operator, wrap/unwrap).
- **Silent failure pattern** — Insufficient balance transfers 0 instead of reverting (no balance info leaked).
- **Pausable** — Owner can pause wrap/unwrap in emergencies.
- **Ownable2Step** — 2-step ownership transfer prevents accidental lock-out.
- **x402 native** — Drop-in SDK for client (fheFetch) and server (fhePaywall) integration.

## Quick Start

```bash
# Install
npm install

# Compile contracts
npx hardhat compile

# Run contract tests (78 tests — fast, mock FHE, no ETH needed)
npx hardhat test

# Build + test SDK (84 tests)
cd sdk && npm install && npx tsup && npx vitest run

# Test Virtuals plugin (30 tests)
cd packages/virtuals-plugin && npm install && npx vitest run

# Test OpenClaw skill (25 tests)
cd packages/openclaw-skill && npm install && npx vitest run

# Build frontend
cd frontend && npm install && npx vite build
```

## Contracts

### ConfidentialUSDC

Inherits: `ZamaEthereumConfig`, `ERC7984`, `ERC7984ERC20Wrapper`, `Ownable2Step`, `Pausable`, `ReentrancyGuard`

| Function | Description |
|----------|-------------|
| `wrap(address to, uint256 amount)` | Wrap plaintext USDC into encrypted cUSDC (fee deducted) |
| `unwrap(address from, address to, bytes32 encAmount, bytes inputProof)` | Request async unwrap (step 1: burn + KMS decrypt request) |
| `finalizeUnwrap(bytes32 burntAmount, uint64 cleartext, bytes proof)` | Finalize unwrap with KMS proof (step 2: fee deducted, USDC sent) |
| `confidentialTransfer(address to, bytes32 encAmount, bytes inputProof)` | Transfer encrypted cUSDC peer-to-peer (fee-free) |
| `confidentialBalanceOf(address account)` | Get encrypted balance handle (euint64) |
| `setOperator(address operator, uint48 until)` | Authorize operator for transfers |
| `isOperator(address holder, address spender)` | Check operator authorization |
| `setTreasury(address newTreasury)` | Update fee treasury (onlyOwner) |
| `treasuryWithdraw()` | Withdraw accumulated fees to treasury |
| `pause() / unpause()` | Emergency pause (onlyOwner) |
| `transferOwnership(address) / acceptOwnership()` | 2-step ownership transfer |

**Events:**

| Event | When |
|-------|------|
| `ConfidentialTransfer(from, to, amount)` | Every encrypted transfer (including wrap mint) |
| `UnwrapRequested(receiver, amount)` | Unwrap initiated |
| `UnwrapFinalized(receiver, encAmount, clearAmount)` | Unwrap completed |
| `TreasuryUpdated(old, new)` | Treasury address changed |
| `TreasuryWithdrawn(treasury, amount)` | Fees withdrawn |

### X402PaymentVerifier

| Function | Description |
|----------|-------------|
| `recordPayment(address payer, address server, bytes32 nonce, uint64 minPrice)` | Record payment nonce with minimum price commitment |
| `usedNonces(bytes32 nonce)` | Check if nonce has been used |

**Events:**

| Event | When |
|-------|------|
| `PaymentVerified(payer, server, nonce, minPrice)` | Payment nonce recorded |

## Deployed Addresses (Sepolia V4.0)

| Contract | Address |
|----------|---------|
| MockUSDC | `0xc89e913676B034f8b38E49f7508803d1cDEC9F4f` |
| ConfidentialUSDC | `0x3864B98D1B1EC2109C679679052e2844b4153889` |
| X402PaymentVerifier | `0xCc60280A10FEB7fBdf20fBefc2abe6E0e99A5A83` |
| Treasury | `0xF505e2E71df58D7244189072008f25f6b6aaE5ae` |

All contracts verified on [Etherscan](https://sepolia.etherscan.io).

## Fee Structure

| Operation | Fee | Notes |
|-----------|-----|-------|
| **Wrap** (USDC to cUSDC) | max(0.1%, 0.01 USDC) | Plaintext fee deducted before minting |
| **Transfer** (cUSDC to cUSDC) | **FREE** | Encrypted peer-to-peer, no fee |
| **Unwrap** (cUSDC to USDC) | max(0.1%, 0.01 USDC) | Fee deducted from decrypted cleartext |

**Breakeven:** 10 USDC (below: flat 0.01 USDC fee; above: 0.1% scales with amount).

| Amount | Wrap Fee | Transfer Fee | Unwrap Fee |
|--------|----------|--------------|------------|
| 1 USDC | 0.01 | 0 | 0.01 |
| 10 USDC | 0.01 | 0 | 0.01 |
| 100 USDC | 0.10 | 0 | 0.10 |
| 1000 USDC | 1.00 | 0 | 1.00 |

## SDK Usage

### Client — Auto-402 Fetch

```typescript
import { fheFetch, createFheFetch } from "fhe-x402-sdk";

// One-shot auto-handle 402 responses
const response = await fheFetch("https://api.example.com/data", {
  tokenAddress: "0x3864B98D1B1EC2109C679679052e2844b4153889",
  verifierAddress: "0xCc60280A10FEB7fBdf20fBefc2abe6E0e99A5A83",
  rpcUrl: "https://sepolia.infura.io/v3/...",
  signer: wallet,
  fhevmInstance: fhevm,
});

// Or create a reusable fetch with pre-configured credentials
const secureFetch = createFheFetch({
  tokenAddress: "0x3864B98D1B1EC2109C679679052e2844b4153889",
  verifierAddress: "0xCc60280A10FEB7fBdf20fBefc2abe6E0e99A5A83",
  rpcUrl: "https://sepolia.infura.io/v3/...",
  signer: wallet,
  fhevmInstance: fhevm,
});
const res = await secureFetch("https://api.example.com/data");
```

### Client — Payment Handler

```typescript
import { FhePaymentHandler } from "fhe-x402-sdk";

const handler = new FhePaymentHandler({
  tokenAddress: "0x3864B98D1B1EC2109C679679052e2844b4153889",
  verifierAddress: "0xCc60280A10FEB7fBdf20fBefc2abe6E0e99A5A83",
  rpcUrl: "https://sepolia.infura.io/v3/...",
  signer: wallet,
  fhevmInstance: fhevm,
});

// Encrypt amount and send dual TX (confidentialTransfer + recordPayment)
const { txHash, verifierTxHash, nonce } = await handler.pay(
  recipientAddress,
  1_000_000n // 1 USDC
);
```

### Server — Paywall Middleware

```typescript
import { fhePaywall } from "fhe-x402-sdk";
import express from "express";

const app = express();

app.use("/api/premium", fhePaywall({
  price: "1000000",        // 1 USDC (6 decimals)
  asset: "USDC",
  tokenAddress: "0x3864B98D1B1EC2109C679679052e2844b4153889",
  verifierAddress: "0xCc60280A10FEB7fBdf20fBefc2abe6E0e99A5A83",
  recipientAddress: "0x...",
  rpcUrl: "https://sepolia.infura.io/v3/...",
  minConfirmations: 1,
}));

app.get("/api/premium/data", (req, res) => {
  res.json({ data: "premium content", paidBy: req.paymentInfo?.from });
});
```

### Facilitator Server

```typescript
import { createFacilitatorServer } from "fhe-x402-sdk";

const app = await createFacilitatorServer({
  tokenAddress: "0x3864B98D1B1EC2109C679679052e2844b4153889",
  verifierAddress: "0xCc60280A10FEB7fBdf20fBefc2abe6E0e99A5A83",
  rpcUrl: "https://sepolia.infura.io/v3/...",
  apiKey: process.env.API_KEY,
});

app.listen(3001);
// GET  /info    — scheme info + contract addresses
// POST /verify  — verify ConfidentialTransfer + PaymentVerified events
// GET  /health  — health check
```

### ERC-8004 Agent Registration

```typescript
import { fhePaymentMethod, fhePaymentProof } from "fhe-x402-sdk";

// For agent registration files (ERC-8004)
const method = fhePaymentMethod({
  tokenAddress: "0x3864B98D1B1EC2109C679679052e2844b4153889",
  verifierAddress: "0xCc60280A10FEB7fBdf20fBefc2abe6E0e99A5A83",
});

// For feedback submission (proof-of-payment)
const proof = fhePaymentProof(nonce, verifierAddress);
```

### NonceStore Interface

The default in-memory nonce store does not survive server restarts. For production, implement the `NonceStore` interface:

```typescript
import type { NonceStore } from "fhe-x402-sdk";

const redisStore: NonceStore = {
  async check(nonce: string): Promise<boolean> {
    return !(await redis.exists(`nonce:${nonce}`));
  },
  async add(nonce: string): Promise<void> {
    await redis.set(`nonce:${nonce}`, "1", "EX", 86400);
  },
};
```

See `examples/redis-nonce-store.ts` for a complete Redis implementation.

## Agent Integrations

### Virtuals GAME Plugin

```typescript
import { FhePlugin } from "@fhe-x402/virtuals-plugin";

const plugin = new FhePlugin({
  credentials: {
    privateKey: process.env.PRIVATE_KEY!,
    tokenAddress: "0x3864B98D1B1EC2109C679679052e2844b4153889",
    verifierAddress: "0xCc60280A10FEB7fBdf20fBefc2abe6E0e99A5A83",
    fhevmInstance,
  },
});

const worker = plugin.getWorker();
// 5 GameFunctions: fhe_wrap, fhe_pay, fhe_unwrap, fhe_balance, fhe_info
```

### OpenClaw Skill

```bash
# Wrap USDC into cUSDC
npx tsx scripts/wrap.ts --amount 10

# Encrypted payment
npx tsx scripts/pay.ts --to 0x... --amount 1

# Request unwrap (cUSDC → USDC)
npx tsx scripts/unwrap.ts --amount 5

# Check USDC balance
npx tsx scripts/balance.ts

# Wallet and contract info
npx tsx scripts/info.ts
```

6 scripts total: `wrap.ts`, `pay.ts`, `unwrap.ts`, `balance.ts`, `info.ts`, `_wallet.ts` (shared config).

### ElizaOS Plugin

See `examples/eliza-plugin/` for a complete ElizaOS integration example with 3 actions: `FHE_PAY`, `FHE_BALANCE`, `FHE_DEPOSIT`.

## Payment Flow

```
1. Agent A sends GET /api/data to Agent B's server.

2. Server has no Payment header → responds 402 with:
   {
     "x402Version": 1,
     "accepts": [{
       "scheme": "fhe-confidential-v1",
       "network": "eip155:11155111",
       "chainId": 11155111,
       "price": "1000000",
       "asset": "USDC",
       "tokenAddress": "0x3864...",
       "verifierAddress": "0x22c0...",
       "recipientAddress": "0x..."
     }]
   }

3. Agent A encrypts the payment amount using fhevmjs:
   input.add64(amount).encrypt() → { handles, inputProof }

4. Agent A sends TX 1: cUSDC.confidentialTransfer(to, handles[0], inputProof)
   → Emits ConfidentialTransfer(from, to, encryptedAmount)

5. Agent A sends TX 2: verifier.recordPayment(payer, server, nonce, minPrice)
   → Emits PaymentVerified(payer, server, nonce, minPrice)

6. Agent A retries the original request with Payment header:
   base64(JSON.stringify({
     scheme: "fhe-confidential-v1",
     txHash: "0x...",           // confidentialTransfer tx
     verifierTxHash: "0x...",   // recordPayment tx
     nonce: "0x...",
     from: "0x...",
     chainId: 11155111
   }))

7. Server middleware decodes the Payment header and verifies:
   a. Scheme matches "fhe-confidential-v1"
   b. Chain ID matches
   c. Nonce is fresh (not replayed)
   d. ConfidentialTransfer event exists in txHash receipt (from + to match)
   e. PaymentVerified event exists in verifierTxHash receipt (minPrice >= required price)
   f. Block confirmations >= minConfirmations

8. Verification passes → next() with req.paymentInfo attached → 200 + data
```

## Project Structure

```
fhe-x402/
├── contracts/
│   ├── ConfidentialUSDC.sol          # ERC-7984 token (wrap/transfer/unwrap + fees)
│   ├── X402PaymentVerifier.sol       # Nonce registry (recordPayment + minPrice)
│   ├── interfaces/
│   │   └── IConfidentialUSDC.sol     # Fee + admin interface
│   └── mocks/
│       └── MockUSDC.sol              # Test token (6 decimals)
├── test/                             # 78 Hardhat tests
│   ├── ConfidentialUSDC.test.ts
│   ├── X402PaymentVerifier.test.ts
│   └── E2E.test.ts
├── sdk/
│   ├── src/
│   │   ├── types.ts                  # FHE x402 types, TOKEN_ABI, VERIFIER_ABI
│   │   ├── fhePaymentHandler.ts      # Client: encrypt + dual TX
│   │   ├── fhePaywallMiddleware.ts   # Server: Express paywall
│   │   ├── fheFetch.ts              # Client: auto-402 fetch
│   │   ├── facilitator.ts           # Facilitator server
│   │   ├── errors.ts                # Error classes
│   │   └── erc8004/index.ts         # ERC-8004 helpers
│   └── tests/                        # 84 SDK tests
├── packages/
│   ├── virtuals-plugin/              # Virtuals GAME plugin (30 tests)
│   │   ├── src/fhePlugin.ts          # 5 GameFunctions
│   │   └── tests/plugin.test.ts
│   └── openclaw-skill/               # OpenClaw skill (25 tests)
│       ├── scripts/                   # 6 CLI scripts
│       └── tests/scripts.test.ts
├── examples/
│   ├── eliza-plugin/                 # ElizaOS example (3 actions)
│   └── redis-nonce-store.ts          # Redis NonceStore implementation
├── frontend/                         # React + Vite demo app
│   └── src/
│       ├── App.tsx
│       └── components/
├── docs/
│   ├── LIGHTPAPER.md                 # Investor/jury-ready paper
│   ├── PROTOCOL.md                   # Technical specification (V4.0)
│   ├── SECURITY.md                   # Security policy + threat model
│   ├── AUDIT-V4.0.md                # V4.0 audit report
│   ├── ROADMAP.md                    # Version milestones
│   └── TODO.md                       # Development tracker
└── deploy/
    └── 01_deploy.ts
```

## Security

### What FHE x402 Protects

- **Payment amounts** — Encrypted via FHE (euint64). No on-chain observer can determine transfer values.
- **Token balances** — Encrypted via FHE. Individual cUSDC balances are not visible on-chain.

### What FHE x402 Does NOT Protect

- **Participant identity** — Sender and recipient addresses are public (x402 requirement).
- **Transaction existence** — Events are emitted for all operations.
- **Wrap/unwrap amounts** — Plaintext USDC enters/exits the encrypted domain visibly.

### Security Measures

- Reentrancy protection (`nonReentrant`) on all state-changing functions
- 2-step ownership transfer (`transferOwnership` + `acceptOwnership`)
- Nonce replay prevention (on-chain `usedNonces` mapping + SDK `NonceStore`)
- Per-IP rate limiting via `req.socket.remoteAddress` (resistant to X-Forwarded-For spoofing)
- minPrice enforcement in `recordPayment` (server verifies committed price)
- Treasury cannot be zero address (constructor check)
- Chain ID verification in middleware
- Payment header size limit (100KB)
- Silent failure pattern preserves balance privacy (FHE.select transfers 0 on insufficient funds)
- API key authentication with timing-safe comparison (facilitator)

### Known Limitations

1. **Silent failure event emission** — `ConfidentialTransfer` fires even on 0-transfer (inherent to FHE). Servers bear bounded risk of one free API response per failed payment.
2. **Dual-TX non-atomicity** — `confidentialTransfer` and `recordPayment` are separate transactions. If the first succeeds and the second fails, funds are transferred but the nonce is not recorded.
3. **In-memory rate limiter** — Resets on server restart. Use external store (Redis) in production.
4. **Mock KMS in tests** — `finalizeUnwrap` uses mock proofs. Production requires real Zama KMS.

See [docs/SECURITY.md](docs/SECURITY.md) for the full threat model and audit history.

## Tech Stack

- Solidity 0.8.27 + `@fhevm/solidity@0.10` + `@fhevm/hardhat-plugin@0.4.0`
- OpenZeppelin Confidential Contracts (ERC-7984, ERC7984ERC20Wrapper)
- TypeScript SDK with `ethers@6` + `tsup` (ESM/CJS)
- Hardhat with viaIR optimizer, Cancun EVM
- Virtuals Protocol GAME SDK
- React + Vite + fhevmjs/web (frontend demo)

## Roadmap

### Completed
- **V4.0** — Token-centric rewrite (ERC-7984 + ERC7984ERC20Wrapper, no pool)
- **V4.1** — Critical fixes (minPrice, assert→revert, unwrap cleanup, OpenClaw addresses)
- **V4.2** — Single-TX payment (payAndRecord, confidentialTransferAndCall + callback)
- **V4.3** — Batch prepayment (recordBatchPayment, batch credit system)
- **V4.2.1** — Security hardening (access control, SafeCast, Pausable ACP, hook safety)

### In Progress
- **V5.0** — ERC-8183 Agentic Commerce (job escrow, 1% completion fee)
- **V5.0** — ERC-8004 full integration (identity registry + reputation + feedback)

### Planned — V6.0 (Production Readiness)
- UUPS proxy pattern for contract upgradeability
- Multisig treasury (Gnosis Safe 2/3 or 3/5)
- KMS emergency withdrawal timelock (30-day governance delay)
- The Graph subgraph for event indexing
- Gas benchmark report (wrap/transfer/unwrap/escrow costs)
- Formal verification (Certora or Halmos state machine proofs)
- Professional third-party audit

### Planned — V7.0 (Ecosystem Growth)
- L2 deployment (Base, Arbitrum — when Zama coprocessor supports L2)
- Multi-token factory (cWETH, cDAI confidential wrappers)
- x402 Foundation membership
- ERC-8183 reference implementation ownership
- Zama partnership (Zaiffer-level collaboration)
- LangChain / CrewAI / AutoGPT agent framework integrations
- Facilitator network (decentralized verification service)
- Mainnet deployment

## License

BUSL-1.1 — converts to GPL-2.0 on March 1, 2030.
