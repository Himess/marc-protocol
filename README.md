# MARC Protocol — Modular Agent-Ready Confidential Protocol

![Tests](https://img.shields.io/badge/tests-800+-brightgreen)
![License](https://img.shields.io/badge/license-BUSL--1.1-blue)
![Chain](https://img.shields.io/badge/chain-Ethereum%20Sepolia-purple)
![SDK](https://img.shields.io/badge/npm-marc--protocol--sdk-red)

## Overview

MARC Protocol is a privacy-preserving payment infrastructure for AI agents. Built on **Zama's fhEVM** and the **x402 payment standard**, it uses Fully Homomorphic Encryption to hide payment amounts on-chain while keeping sender and recipient addresses public (as required by x402).

**Scheme:** `fhe-confidential-v1` | **Chain:** Ethereum Sepolia (11155111) | **Tests:** 800+ (305 contract + 328 Sepolia on-chain + 173 SDK + 37 Virtuals + 31 OpenClaw)

### Why MARC?

AI agents are already transacting at scale — **$166M+ x402 volume across chains** (Dune Analytics, Q1 2026). But every payment amount, every balance, every transaction outcome is **publicly visible on-chain**. Competitors can see your API spend, your pricing strategy, your customer base.

MARC Protocol encrypts what matters: **amounts and balances are FHE-encrypted**, while participants remain public for x402 compliance.

### Multi-Chain Vision

Zama's fhEVM is **chain-agnostic** — it deploys as a coprocessor on any EVM chain. This means MARC Protocol works **everywhere Zama goes**:

| Chain | Status | Impact |
|-------|--------|--------|
| **Ethereum** | Live (Sepolia) | Largest DeFi TVL, highest security |
| **Base** | Planned | #1 in x402 volume (Coinbase ecosystem) |
| **Arbitrum** | Planned | Largest L2 by TVL |
| **Polygon** | Planned | Enterprise + gaming agents |
| **Any future EVM L1/L2** | Automatic | Wherever Zama deploys, MARC follows |

When Zama deploys to Base, Arbitrum, and beyond — **agents on every major chain can make confidential payments through MARC Protocol.** One protocol, every chain, full privacy.

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
    |  1. fhevm.encrypt(amount)                |
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

# Run contract tests (305 tests — fast, mock FHE, no ETH needed)
npx hardhat test

# Build + test SDK (173 tests)
cd sdk && npm install && npx tsup && npx vitest run

# Test Virtuals plugin (37 tests)
cd packages/virtuals-plugin && npm install && npx vitest run

# Test OpenClaw skill (31 tests)
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

## Deployed Addresses (Sepolia V4.3)

| Contract | Address |
|----------|---------|
| MockUSDC | [`0xc89e913676B034f8b38E49f7508803d1cDEC9F4f`](https://sepolia.etherscan.io/address/0xc89e913676B034f8b38E49f7508803d1cDEC9F4f) |
| ConfidentialUSDC | [`0xE944754aa70d4924dc5d8E57774CDf21Df5e592D`](https://sepolia.etherscan.io/address/0xE944754aa70d4924dc5d8E57774CDf21Df5e592D) |
| X402PaymentVerifier | [`0x4503A7aee235aBD10e6064BBa8E14235fdF041f4`](https://sepolia.etherscan.io/address/0x4503A7aee235aBD10e6064BBa8E14235fdF041f4) |
| AgenticCommerceProtocol | [`0xBCA8d5ce6D57f36c7aF71954e9F7f86773a02F22`](https://sepolia.etherscan.io/address/0xBCA8d5ce6D57f36c7aF71954e9F7f86773a02F22) |
| AgentIdentityRegistry | [`0xf4609D5DB3153717827703C795acb00867b69567`](https://sepolia.etherscan.io/address/0xf4609D5DB3153717827703C795acb00867b69567) |
| AgentReputationRegistry | [`0xd1Dd10990f317802c79077834c75742388959668`](https://sepolia.etherscan.io/address/0xd1Dd10990f317802c79077834c75742388959668) |
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
import { fheFetch, createFheFetch } from "marc-protocol-sdk";

// One-shot auto-handle 402 responses
const response = await fheFetch("https://api.example.com/data", {
  tokenAddress: "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D",
  verifierAddress: "0x4503A7aee235aBD10e6064BBa8E14235fdF041f4",
  rpcUrl: "https://sepolia.infura.io/v3/...",
  signer: wallet,
  fhevmInstance: fhevm,
});

// Or create a reusable fetch with pre-configured credentials
const secureFetch = createFheFetch({
  tokenAddress: "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D",
  verifierAddress: "0x4503A7aee235aBD10e6064BBa8E14235fdF041f4",
  rpcUrl: "https://sepolia.infura.io/v3/...",
  signer: wallet,
  fhevmInstance: fhevm,
});
const res = await secureFetch("https://api.example.com/data");
```

### Client — Payment Handler

```typescript
import { FhePaymentHandler } from "marc-protocol-sdk";

const handler = new FhePaymentHandler({
  tokenAddress: "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D",
  verifierAddress: "0x4503A7aee235aBD10e6064BBa8E14235fdF041f4",
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
import { fhePaywall } from "marc-protocol-sdk";
import express from "express";

const app = express();

app.use("/api/premium", fhePaywall({
  price: "1000000",        // 1 USDC (6 decimals)
  asset: "USDC",
  tokenAddress: "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D",
  verifierAddress: "0x4503A7aee235aBD10e6064BBa8E14235fdF041f4",
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
import { createFacilitatorServer } from "marc-protocol-sdk";

const app = await createFacilitatorServer({
  tokenAddress: "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D",
  verifierAddress: "0x4503A7aee235aBD10e6064BBa8E14235fdF041f4",
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
import { fhePaymentMethod, fhePaymentProof } from "marc-protocol-sdk";

// For agent registration files (ERC-8004)
const method = fhePaymentMethod({
  tokenAddress: "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D",
  verifierAddress: "0x4503A7aee235aBD10e6064BBa8E14235fdF041f4",
});

// For feedback submission (proof-of-payment)
const proof = fhePaymentProof(nonce, verifierAddress);
```

### NonceStore Interface

The default in-memory nonce store does not survive server restarts. For production, implement the `NonceStore` interface:

```typescript
import type { NonceStore } from "marc-protocol-sdk";

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
import { FhePlugin } from "@marc-protocol/virtuals-plugin";

const plugin = new FhePlugin({
  credentials: {
    privateKey: process.env.PRIVATE_KEY!,
    tokenAddress: "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D",
    verifierAddress: "0x4503A7aee235aBD10e6064BBa8E14235fdF041f4",
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

3. Agent A encrypts the payment amount using @zama-fhe/relayer-sdk:
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
marc-protocol/
├── contracts/
│   ├── ConfidentialUSDC.sol          # ERC-7984 token (wrap/transfer/unwrap + fees)
│   ├── X402PaymentVerifier.sol       # Nonce registry (recordPayment + minPrice)
│   ├── AgenticCommerceProtocol.sol   # ERC-8183 job escrow (1% platform fee)
│   ├── AgentIdentityRegistry.sol     # ERC-8004 agent identity (Ownable2Step + Pausable)
│   ├── AgentReputationRegistry.sol   # ERC-8004 reputation + feedback (Ownable2Step + Pausable)
│   ├── interfaces/
│   │   └── IConfidentialUSDC.sol     # Fee + admin interface
│   └── mocks/
│       └── MockUSDC.sol              # Test token (6 decimals)
├── test/                             # 305 Hardhat + 328 Sepolia on-chain tests
│   ├── ConfidentialUSDC.test.ts
│   ├── X402PaymentVerifier.test.ts
│   ├── AgenticCommerceProtocol.test.ts
│   ├── AgentIdentityRegistry.test.ts
│   ├── AgentReputationRegistry.test.ts
│   ├── E2E.test.ts
│   └── Sepolia.*.test.ts            # Real Sepolia on-chain tests (skip on local)
├── sdk/
│   ├── src/
│   │   ├── types.ts                  # FHE x402 types, TOKEN_ABI, VERIFIER_ABI
│   │   ├── fhePaymentHandler.ts      # Client: encrypt + dual TX
│   │   ├── fhePaywallMiddleware.ts   # Server: Express paywall
│   │   ├── fheFetch.ts              # Client: auto-402 fetch
│   │   ├── facilitator.ts           # Facilitator server
│   │   ├── errors.ts                # Error classes
│   │   └── erc8004/index.ts         # ERC-8004 helpers
│   └── tests/                        # 173 SDK tests
│   ├── erc8004/index.ts             # ERC-8004 helpers
│   ├── erc8183/index.ts             # ERC-8183 Agentic Commerce
│   ├── silentFailureGuard.ts        # FHE silent failure mitigation
│   ├── redisNonceStore.ts           # Production Redis nonce store
│   └── redisBatchCreditStore.ts     # Batch credit persistence
├── packages/
│   ├── virtuals-plugin/              # Virtuals GAME plugin
│   │   ├── src/fhePlugin.ts          # 5 GameFunctions
│   │   └── tests/plugin.test.ts
│   └── openclaw-skill/               # OpenClaw skill
│       ├── scripts/                   # 6 CLI scripts
│       └── tests/scripts.test.ts
├── examples/
│   ├── eliza-plugin/                 # ElizaOS example (3 actions)
│   └── redis-nonce-store.ts          # Redis NonceStore implementation
├── frontend/                         # React + Vite + @zama-fhe/relayer-sdk demo
│   └── src/
│       ├── App.tsx                   # Main app (5 tabs: Dashboard/Wallet/Pay/Jobs/Agents)
│       ├── config.ts                 # Contract addresses + ABIs
│       └── *Tab.tsx                  # Tab components
├── demo/
│   ├── marc-agent-lifecycle.ts       # Full 6-step lifecycle demo (video-ready)
│   ├── marc-virtuals-agent.ts        # Autonomous Virtuals agent demo (video-ready)
│   ├── agent-demo.ts                 # Basic agent payment demo
│   ├── agent-seller.ts               # Express paywall server
│   └── agent-buyer.ts                # Client using fheFetch
├── docs/
│   ├── LIGHTPAPER.md                 # Investor/jury-ready paper
│   ├── REVENUE-PROJECTIONS.md        # Revenue model + market analysis
│   ├── PROTOCOL.md                   # Technical specification (V4.0)
│   ├── SECURITY.md                   # Security policy + threat model
│   ├── AUDIT-FINDINGS-V4.3.md       # V4.3 deep audit report
│   ├── ROADMAP.md                    # Version milestones
│   └── TODO.md                       # Development tracker
└── deploy/
    └── 01_deploy.ts
```

## Revenue Model

### Two Unbypassable Fee Streams

| Stream | Rate | Trigger | Enforcement |
|--------|------|---------|-------------|
| **Wrap/Unwrap Fee** | 0.1% (min $0.01) | USDC enters/exits encrypted layer | Contract-level (`accumulatedFees → treasury`) |
| **ERC-8183 Job Escrow** | 1% platform fee | Job completion | Contract-level (`PLATFORM_FEE_BPS = 100`) |

**ERC-8183 Job Escrow — Primary Revenue:**
Agent creates job → funds locked in escrow → work delivered → evaluator approves → **99% to provider, 1% to protocol**. The 1% fee is enforced at the contract level — mathematically unbypassable.

**Transfers are fee-free** — this incentivizes agents to stay in the encrypted cUSDC layer, increasing protocol stickiness and reducing exit friction.

### Revenue Projections

| Year | Scenario | Wrap/Unwrap Fee | Job Escrow (1%) | Enterprise | Total |
|------|----------|-----------------|-----------------|-----------|-------|
| **2026** | Conservative | $24K | $3K | $0 | **$27K** |
| **2026** | Base | $90K | $60K | $50K | **$200K** |
| **2026** | Optimistic | $240K | $1.2M | $150K | **$1.59M** |
| **2027** | Multi-Chain | $1M | $3M | $300K | **$4.3M** |
| **2028+** | Mainstream | $5M | $15M | $1M | **$21M** |

Key insight: **every new chain Zama deploys to multiplies MARC's addressable market.** Current x402 volume is $166M+ and growing. MARC needs just 2-5% adoption for meaningful revenue.

See [docs/REVENUE-PROJECTIONS.md](docs/REVENUE-PROJECTIONS.md) for detailed projections, sensitivity analysis, and market context.

## Security

### What MARC Protocol Protects

- **Payment amounts** — Encrypted via FHE (euint64). No on-chain observer can determine transfer values.
- **Token balances** — Encrypted via FHE. Individual cUSDC balances are not visible on-chain.

### What MARC Protocol Does NOT Protect

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

- Solidity 0.8.24 + `@fhevm/solidity@0.10` + `@fhevm/hardhat-plugin@0.4.0`
- OpenZeppelin Confidential Contracts (ERC-7984, ERC7984ERC20Wrapper)
- TypeScript SDK with `ethers@6` + `tsup` (ESM/CJS)
- Hardhat with viaIR optimizer, Cancun EVM
- Virtuals Protocol GAME SDK
- React + Vite + @zama-fhe/relayer-sdk/web (frontend demo)

## Roadmap

### Completed
- **V4.0** — Token-centric rewrite (ERC-7984 + ERC7984ERC20Wrapper, no pool)
- **V4.1** — Critical fixes (minPrice, assert→revert, unwrap cleanup, OpenClaw addresses)
- **V4.2** — Single-TX payment (payAndRecord, confidentialTransferAndCall + callback)
- **V4.3** — Batch prepayment (recordBatchPayment, batch credit system)
- **V4.2.1** — Security hardening (access control, SafeCast, Pausable ACP, hook safety)

### Completed (V4.3)
- **V4.3** — ERC-8183 Agentic Commerce (job escrow, 1% completion fee)
- **V4.3** — ERC-8004 full integration (identity + reputation + feedback, deployed + verified)
- **V4.3** — Deep audit: 414 tests, all CRITICAL/HIGH/MEDIUM findings fixed
- **V4.3** — Frontend: 5-tab UI (Dashboard, Wallet, Pay, Jobs, Agents)
- **V4.3** — Redis stores, silent failure guard, batch prepayment

### Planned — V6.0 (Production Readiness)
- UUPS proxy pattern for contract upgradeability
- Multisig treasury (Gnosis Safe 2/3 or 3/5)
- KMS emergency withdrawal timelock (30-day governance delay)
- The Graph subgraph for event indexing
- Gas benchmark report (wrap/transfer/unwrap/escrow costs)
- Formal verification (Certora or Halmos state machine proofs)
- Professional third-party audit

### Planned — V7.0 (Multi-Chain Expansion)
- **Base deployment** — #1 chain for x402 volume (Coinbase ecosystem)
- **Arbitrum deployment** — Largest L2 by TVL
- **Ethereum Mainnet** — Highest security, largest DeFi TVL
- Multi-token factory (cWETH, cDAI confidential wrappers)
- x402 Foundation membership
- ERC-8183 reference implementation ownership
- ERC-8126 risk scoring (agent reputation risk framework)
- Zama partnership (Zaiffer cUSDC migration)
- LangChain / CrewAI / AutoGPT agent framework integrations
- Facilitator network (decentralized verification service)
- **Goal: MARC Protocol live on every chain where Zama fhEVM deploys**

## License

BUSL-1.1 — converts to GPL-2.0 on March 1, 2030.
