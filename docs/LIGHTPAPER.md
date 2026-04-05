# FHE x402: Encrypted Payment Protocol for the Agent Economy

*v1.0.0 — March 2026*

## Table of Contents

1. [Abstract](#abstract)
2. [The Problem](#the-problem)
3. [The Solution](#the-solution)
4. [Architecture](#architecture)
5. [ERC Standards Integration](#erc-standards-integration)
6. [Revenue Model](#revenue-model)
7. [Competitive Landscape](#competitive-landscape)
8. [Agent Integrations](#agent-integrations)
9. [Roadmap](#roadmap)
10. [Team](#team)
11. [The Ask](#the-ask)

---

## Abstract

FHE x402 is a token-centric privacy protocol for AI agent payments on Ethereum. Agents wrap USDC into encrypted cUSDC (an ERC-7984 confidential token), hold it directly in their wallets, and transfer it peer-to-peer with fully encrypted amounts. There is no intermediary contract holding funds — agents own their encrypted balances outright. Payment verification uses a thin nonce registry (X402PaymentVerifier) so servers can confirm that a payment occurred and meets a minimum price, without ever learning the actual amount transferred. The protocol integrates natively with the x402 HTTP payment standard, ERC-8004 agent identity, and ERC-8183 agentic commerce.

900+ tests. Deployed on Ethereum Sepolia. Two contracts. No trusted setup.

## The Problem

> *"Crypto privacy is needed if you want to make API calls without compromising the information of your access patterns. Even with a local AI agent, you can learn a lot about what someone is doing if you see all of their search engine calls. [...] providers will demand an anti-DoS mechanism, and realistically payment per call. By default that will be credit card or some corposlop stablecoin thing — so we need crypto privacy."*
>
> — [Vitalik Buterin, March 2026](https://x.com/VitalikButerin/status/2030510783134871594)

### AI Agents Have No Financial Privacy

The agent economy is growing rapidly:

- **$600M+** cumulative x402 payment volume across all chains (Q1 2026)
- **122M+** x402 transactions processed
- **24,000+** agents registered on ERC-8004
- **ZERO amount privacy**: every payment amount is publicly visible on-chain

### Why This Matters

- **Strategy Leakage**: Competing agents can monitor each other's API spending and data purchases
- **MEV Extraction**: Visible payment amounts enable front-running and sandwich attacks
- **Competitive Intelligence**: Payment history reveals operational strategy
- **Price Discrimination**: Servers can adjust prices based on observed spending patterns

### The Privacy Gap

| Layer | Standard | Privacy |
|-------|----------|---------|
| Identity & Trust | ERC-8004 | Public (by design) |
| Payment Protocol | x402 | Public (amounts visible) |
| Settlement | Ethereum L1 | Public (transparent) |

FHE x402 fills the missing privacy layer for payment amounts.

## The Solution

### Token-Centric Encrypted Payments

FHE x402 takes a fundamentally different approach from privacy mixers or shielded ledgers. Instead of locking funds in a shared contract, agents hold encrypted tokens directly in their own wallets:

**ERC-7984 Confidential Token (cUSDC)**
- Agents wrap plaintext USDC into encrypted cUSDC
- All cUSDC balances are stored as `euint64` (FHE-encrypted 64-bit unsigned integers)
- Agents hold cUSDC in their own wallets — no shared contract, no custodial risk
- `confidentialTransfer()` moves encrypted amounts peer-to-peer with zero protocol fee
- When done, agents unwrap cUSDC back to plaintext USDC

**Silent Failure Pattern**
- FHE encrypted booleans cannot be branched on in Solidity
- Insufficient balance transfers 0 instead of reverting
- No information leaks through transaction success/failure

**x402 Native Integration**
- Scheme: `fhe-confidential-v1`
- Drop-in Express middleware: `fhePaywall(config)`
- Auto-402 fetch: `fheFetch(url, options)`
- Event-based verification (no ZK proofs needed)

**ERC-8004 Complementary**
- Agent identity: PUBLIC (ERC-8004 registry)
- Agent reputation: PUBLIC (ERC-8004 feedback)
- Payment amounts: ENCRYPTED (FHE x402)

**Agent Framework Integrations**
- **Virtuals GAME Plugin**: 5 GameFunctions — autonomous agent payments
- **OpenClaw Skill**: 6 scripts — declarative skill for any OpenClaw agent
- **ElizaOS Plugin**: 3 actions — example integration
- **npm SDK**: `fhe-x402-sdk` — ready for any framework

**Facilitator Server**
- x402-standard compatible: /verify, /info, /health endpoints
- Dual event verification (ConfidentialTransfer + PaymentVerified on-chain)
- API key authentication with constant-time comparison

### How It Works

```
Agent wraps USDC → receives cUSDC in wallet
    |
Agent discovers API via ERC-8004 registry
    |
Agent requests API → receives HTTP 402
    |
Agent encrypts payment amount with fhevmjs
    |
cUSDC.confidentialTransfer(to, encryptedAmount, inputProof)
    |
verifier.recordPayment(payer, server, nonce, minPrice)
    |
  [payAndRecord() — single TX combining both steps]
    |
Server verifies ConfidentialTransfer + PaymentVerified events on-chain
    |
Agent receives API response → HTTP 200
    |
On-chain: encrypted balances change, amounts are HIDDEN
          sender/receiver addresses are PUBLIC (x402 requirement)
```

### Privacy Model

| What | Visible? |
|------|----------|
| Wrap amount (USDC to cUSDC) | Yes (plaintext USDC enters encrypted domain) |
| Unwrap amount (cUSDC to USDC) | Yes (plaintext USDC exits encrypted domain) |
| Transfer amount (cUSDC to cUSDC) | **No** (FHE encrypted) |
| cUSDC balance | **No** (FHE encrypted) |
| Sender address | Yes (x402 requirement) |
| Recipient address | Yes (x402 requirement) |
| Transaction occurred | Yes (event emitted) |

**Key difference from ZK-UTXO (PrivAgent):** FHE x402 encrypts amounts but keeps participants public. This is a deliberate design choice — x402 requires sender/recipient to be known for payment verification. FHE provides amount privacy without the complexity of UTXO management, ZK circuits, or trusted setup ceremonies.

## Architecture

### Protocol Stack

```
+------------------------------------------+
|  Agent Frameworks                        |
|  Virtuals GAME · OpenClaw · ElizaOS      |
+------------------------------------------+
|  ERC-8183: Agentic Commerce              |
|  (Job escrow + completion payments)      |
+------------------------------------------+
|  ERC-8004: Identity + Reputation         |
|  (Agent discovery & trust)               |
+------------------------------------------+
|  FHE x402: Amount Privacy Layer          |
|  (Encrypted balances + silent failure)   |
+------------------------------------------+
|  x402: Payment Protocol                  |
|  (HTTP 402 → pay → 200)                 |
+------------------------------------------+
|  Ethereum (Sepolia / Mainnet)            |
+------------------------------------------+
```

### Core Components

1. **ConfidentialUSDC** — ERC-7984 confidential token wrapper. Wraps plaintext USDC into encrypted cUSDC. Agents hold cUSDC directly in their wallets. Fee-free peer-to-peer transfers. 0.1% fee on wrap and unwrap only. 2-step async unwrap via KMS.
2. **X402PaymentVerifier** — Thin nonce registry. Records payment nonces with `minPrice` for server-side price verification. Permissionless (any agent can record).
3. **TypeScript SDK** — Payment handler, Express middleware, auto-402 fetch wrapper, facilitator server, ERC-8004 helpers, ERC-8183 escrow helpers.
4. **Agent Plugins** — Virtuals GAME (5 functions, 30 tests), OpenClaw (6 scripts, 25 tests), ElizaOS (3 actions).
5. **Frontend Demo** — React app for wrap/transfer/unwrap.

### Smart Contracts (Sepolia — Live)

| Contract | Address |
|----------|---------|
| MockUSDC | `0xc89e913676B034f8b38E49f7508803d1cDEC9F4f` |
| ConfidentialUSDC | `0xE944754aa70d4924dc5d8E57774CDf21Df5e592D` |
| X402PaymentVerifier | `0x4503A7aee235aBD10e6064BBa8E14235fdF041f4` |
| Treasury | `0xF505e2E71df58D7244189072008f25f6b6aaE5ae` |

All contracts verified on [Etherscan](https://sepolia.etherscan.io).

## ERC Standards Integration

FHE x402 is built on three complementary ERC standards:

### ERC-7984: Confidential Token Standard

The foundation. ConfidentialUSDC implements the ERC-7984 interface with ERC7984ERC20Wrapper for USDC wrapping. Provides `confidentialBalanceOf`, `confidentialTransfer`, `setOperator`, and standard wrap/unwrap lifecycle.

### ERC-8004: Agent Identity & Reputation

Agents register their FHE x402 payment capabilities in the ERC-8004 registry. The SDK provides `fhePaymentMethod()` for registration and `fhePaymentProof()` for proof-of-payment feedback. Identity is public by design — only payment amounts are encrypted.

### ERC-8183: Agentic Commerce Protocol

Job escrow for multi-step agent workflows. A client agent posts a job with encrypted escrow, a provider agent completes the work, and funds are released on completion. 1% completion fee funds protocol development. Enables complex agent-to-agent commerce beyond simple API payments.

## Revenue Model

### 3-Tier Fee Structure

| Fee Type | Amount | Trigger | Recipient |
|----------|--------|---------|-----------|
| Wrap/Unwrap fee | max(0.1%, $0.01) | Entering or exiting encrypted domain | Treasury |
| Escrow completion fee (ERC-8183) | 1% | Job completed and escrow released | Treasury |
| Facilitator SaaS | $0.01-0.05/TX or monthly subscription | Payment verification service | Facilitator operator |

### Why Transfers Are Free

Agent-to-agent `confidentialTransfer()` carries zero protocol fee. This is intentional — fee-free transfers maximize adoption and network effects. Revenue comes from the entry/exit points (wrap/unwrap) and from higher-value escrow completions (ERC-8183).

### Unit Economics

| Amount | Wrap Fee | Transfer Fee | Unwrap Fee | Total Round-Trip |
|--------|----------|--------------|------------|-----------------|
| 1 USDC | 0.01 | 0 | 0.01 | 0.02 |
| 10 USDC | 0.01 | 0 | 0.01 | 0.02 |
| 100 USDC | 0.10 | 0 | 0.10 | 0.20 |
| 1000 USDC | 1.00 | 0 | 1.00 | 2.00 |

### Growth Scenarios

**Conservative (2026):**
- 3% of Ethereum x402 volume = ~$15M
- ~3M wrap/unwrap events at $0.01 min fee = ~$30K protocol revenue
- + ERC-8183 escrow completions

**Optimistic (2027):**
- 7% of x402 volume with L2 deployment = ~$500M
- ~100M events = ~$1M protocol revenue
- + facilitator SaaS subscriptions

## Competitive Landscape

| Feature | FHE x402 | PrivAgent (ZK) | Mind Network x402z | Fhenix402 | Zaiffer |
|---------|----------|---------------|-------------------|-----------|---------|
| Ethereum L1 | Yes | No (Base) | No (Mind L2) | Yes (Fhenix L2) | Yes (Zama) |
| x402 native | Yes | Yes | Yes | Partial | No |
| ERC-8004 | Yes | Yes | No | No | No |
| ERC-8183 escrow | Yes | No | No | No | No |
| Amount privacy | Yes (FHE) | Yes (ZK) | Yes (FHE) | Yes (FHE) | Yes (FHE) |
| Sender privacy | No | Yes | No | No | No |
| No trusted setup | Yes | No (Groth16) | Yes | Yes | Yes |
| Silent failure | Yes | No | No | No | Yes |
| Token-centric (no shared contract) | Yes | No (shielded UTXO) | No | Partial | No |
| Agent integrations | 3 frameworks | 2 frameworks | 0 | 0 | 0 |
| Tests | 900+ | 282 | Unknown | Unknown | Unknown |

**FHE x402 vs PrivAgent:** Complementary approaches. FHE x402 provides amount privacy with simpler architecture (no circuits, no trusted setup, token-centric). PrivAgent provides full privacy (amounts + participants) with ZK-UTXO complexity.

**FHE x402 vs Mind Network x402z / Fhenix402:** All use FHE, but FHE x402 is the only one with ERC-8004 identity integration, ERC-8183 escrow, agent framework plugins, and a token-centric design where agents hold funds directly.

**FHE x402 vs Zaiffer:** Both use Zama's fhEVM. Zaiffer focuses on DeFi (encrypted AMM), while FHE x402 focuses on the agent payment layer with x402 integration.

## Agent Integrations

### Virtuals GAME Plugin (30 tests)

5 GameFunctions for autonomous agent payments:
- `fhe_wrap` — Wrap USDC into encrypted cUSDC
- `fhe_pay` — Encrypted transfer + nonce recording
- `fhe_unwrap` — Request unwrap (cUSDC to USDC)
- `fhe_balance` — Check USDC balance
- `fhe_info` — Wallet and contract info

### OpenClaw Skill (25 tests)

6 CLI scripts for declarative agent integration:
- `wrap.ts`, `pay.ts`, `unwrap.ts`, `balance.ts`, `info.ts`, `_wallet.ts` (shared config)

### ElizaOS Plugin (Example)

3 actions: `FHE_PAY`, `FHE_BALANCE`, `FHE_WRAP`. See `examples/eliza-plugin/` for complete integration.

### Any Framework (npm SDK)

```typescript
import { fheFetch } from "fhe-x402-sdk";

const response = await fheFetch("https://api.example.com/data", {
  tokenAddress: "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D",
  verifierAddress: "0x4503A7aee235aBD10e6064BBa8E14235fdF041f4",
  rpcUrl: "https://sepolia.infura.io/v3/...",
  signer: wallet,
  fhevmInstance: fhevm,
});
```

## Roadmap

| Phase | Status | Deliverables |
|-------|--------|-------------|
| **v1.0.0** | Complete | Token-centric architecture. ConfidentialUSDC (ERC-7984) + X402PaymentVerifier. Single-TX payment (`payAndRecord`). Batch prepayment (`recordBatchPayment`). TypeScript SDK. Agent plugins. 900+ tests. Sepolia deployment. |
| **v1.1** | In Progress | ERC-8183 Agentic Commerce: job escrow, 1% completion fee. ERC-8004 full integration: identity + reputation + feedback. |
| **v1.2** | Planned | ERC-8126 risk scoring. Encrypted reputation (FHE + ERC-8004). Multi-token factory (cWETH, cDAI). |
| **v2.0** | Planned | Cross-chain L2 (Base, Arbitrum). Mainnet deployment with professional audit. |

## Team

### Himess — Founder & Developer

- 5+ years crypto/blockchain development
- 80+ merged PRs: reth, revm, Base, Optimism, Miden VM, Celestia
- Zama Developer Program participant — FHEVM Bootcamp curriculum (328 tests, 20 modules)
- Arc x Lablab AI Hackathon Winner — ArcPay SDK
- PrivAgent — ZK privacy protocol on Base (282 tests, V4.4)
- MixVM — Cross-chain privacy bridge (CCTP V2 + LayerZero)

## The Ask

**What we've built (v1.0.0 — complete):**
- ConfidentialUSDC: ERC-7984 token wrapper with encrypted balances, fee-free transfers, 0.1% wrap/unwrap fee
- X402PaymentVerifier: nonce registry with minPrice verification
- Single-TX payment (payAndRecord) and batch prepayment (recordBatchPayment)
- TypeScript SDK: payment handler, paywall middleware, auto-402 fetch, facilitator server
- Agent integrations: Virtuals GAME (5 functions, 30 tests), OpenClaw (6 scripts, 25 tests), ElizaOS (3 actions)
- ERC-8004 integration helpers
- React frontend demo
- 900+ tests, internally reviewed, deployed on Ethereum Sepolia

**What we're building next:**
1. ERC-8183 Agentic Commerce — job escrow for multi-step agent workflows (1% completion fee)
2. ERC-8004 full integration — identity + reputation + encrypted feedback
3. Multi-token factory — wrap any ERC-20 as a confidential ERC-7984 token
4. Cross-chain L2 deployment — Base, Arbitrum (when Zama coprocessor supports L2)
5. Ethereum mainnet deployment with professional security audit

---

*FHE x402 is licensed under the Business Source License 1.1.
Converts to GPL-2.0 on March 1, 2030.*
