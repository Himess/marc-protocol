# FHE x402: Encrypted Payment Infrastructure for the Agent Economy

*Version 1.0 — March 2026*

## Table of Contents

1. [Abstract](#abstract)
2. [The Problem](#the-problem)
3. [The Solution](#the-solution)
4. [Architecture](#architecture)
5. [Revenue Model](#revenue-model)
6. [Competitive Landscape](#competitive-landscape)
7. [Roadmap](#roadmap)
8. [Team](#team)
9. [The Ask](#the-ask)

---

## Abstract

FHE x402 is a privacy-preserving payment protocol for AI agents on Ethereum. It uses Fully Homomorphic Encryption (FHE) via Zama's fhEVM to enable encrypted micropayments between autonomous agents. Payment amounts are encrypted on-chain — observers see transactions occur but cannot determine how much was paid. FHE x402 integrates natively with Coinbase's x402 HTTP payment standard and ERC-8004 agent identity.

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

### FHE x402: Encrypted Payments for Ethereum

FHE x402 brings amount privacy to Ethereum's agent economy using Zama's fhEVM:

**FHE Encrypted Balances**
- All balances stored as `euint64` (encrypted 64-bit unsigned integers)
- Computations happen directly on encrypted values on-chain
- No one — not even the contract owner — can see balances

**Silent Failure Pattern**
- FHE encrypted booleans cannot be branched on in Solidity
- Insufficient balance → transfer 0 instead of reverting
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
- Event-based verification (checks PaymentExecuted on-chain)
- API key authentication with constant-time comparison

### How It Works

```
Agent discovers API via ERC-8004 registry
    |
Agent requests API → receives HTTP 402
    |
Agent encrypts payment amount with fhevmjs
    |
pool.pay(to, encryptedAmount, inputProof, minPrice, nonce)
    |
Server verifies PaymentExecuted event on-chain
    |
Agent receives API response → HTTP 200
    |
On-chain: encrypted balances change, amounts are HIDDEN
          sender/receiver addresses are PUBLIC (x402 requirement)
```

### Privacy Model

| What | Visible? |
|------|----------|
| Agent uses FHE pool (deposit) | Yes (public deposit event) |
| Payment amount | No (FHE encrypted) |
| Sender address | Yes (x402 requirement) |
| Recipient address | Yes (x402 requirement) |
| Pool balance | No (FHE encrypted) |
| Transaction occurred | Yes (event emitted) |

**Key difference from ZK-UTXO (PrivAgent):** FHE x402 encrypts amounts but keeps participants public. This is a deliberate design choice — x402 requires sender/recipient to be known for payment verification. FHE provides amount privacy without the complexity of UTXO management, ZK circuits, or trusted setup ceremonies.

## Architecture

### Protocol Stack

```
+------------------------------------------+
|  Agent Frameworks                        |
|  Virtuals GAME · OpenClaw · ElizaOS      |
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

1. **ConfidentialPaymentPool** — Solidity contract with FHE encrypted balances (euint64), silent failure pattern, protocol fees, 2-step async withdrawal via KMS
2. **TypeScript SDK** — Payment handler, Express middleware, auto-402 fetch wrapper, facilitator server, ERC-8004 helpers
3. **Agent Plugins** — Virtuals GAME (5 functions), OpenClaw (6 scripts), ElizaOS (3 actions)
4. **Frontend Demo** — React app for deposit/pay/withdraw

### Smart Contracts (Sepolia — Live)

| Contract | Address |
|----------|---------|
| MockUSDC | `0x229146B746cf3A314dee33f08b84f8EFd5F314F4` |
| ConfidentialPaymentPool | `0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73` |

All contracts verified on Etherscan.

## Revenue Model

### Fee Structure

| Fee Type | Amount | Recipient |
|----------|--------|-----------|
| Protocol fee (ALL transactions) | max(0.1%, $0.01) | Treasury |
| Facilitator fee | $0.01-0.05/TX | Facilitator operator |
| Enterprise SDK license | $50K/year | FHE x402 team |

### Unit Economics

- Ethereum L1 gas cost: ~$0.50-2.00 per TX (varies)
- Protocol fee per TX: >= $0.01
- **Net margin per TX: positive on high-value payments**

### Growth Scenarios

**Conservative (2026):**
- 3% of Ethereum x402 volume = ~$15M
- ~3M transactions at $0.01 min fee = ~$30K protocol fee

**Optimistic (2027):**
- 7% of x402 volume with L2 deployment = ~$500M
- ~100M transactions = ~$1M protocol fee

## Competitive Landscape

| Feature | FHE x402 | PrivAgent (ZK) | Railgun | Tornado Cash |
|---------|----------|---------------|---------|-------------|
| Ethereum L1 | Yes | No (Base) | No | No (sanctioned) |
| x402 native | Yes | Yes | No | No |
| ERC-8004 | Yes | Yes | No | No |
| Amount privacy | Yes (FHE) | Yes (ZK) | Yes (ZK) | No (fixed) |
| Sender privacy | No | Yes | Yes | Yes |
| No trusted setup | Yes | No (Groth16) | No | No |
| Silent failure | Yes | No | No | No |
| On-chain compute | Yes (FHE ops) | Yes (ZK verify) | Yes | Yes |

**FHE x402 vs PrivAgent:** Complementary approaches. FHE x402 provides amount privacy with simpler architecture (no circuits, no trusted setup). PrivAgent provides full privacy (amounts + participants) with more complexity.

## Roadmap

| Phase | Timeline | Deliverables |
|-------|----------|-------------|
| **V1.0** | Complete | ConfidentialPaymentPool, SDK (handler, middleware, fetch), 138 tests, Sepolia deployment |
| **V1.1** | Complete | Facilitator server, ERC-8004 helpers, Virtuals plugin, OpenClaw skill, ElizaOS example, frontend demo, 210+ tests |
| **V1.2** | Weeks 1-4 | Mainnet deployment, professional audit, documentation |
| **V2.0** | Months 3-6 | L2 deployment (Base, Arbitrum), multi-token support, decryption gateway |
| **V2.1** | Months 6-12 | Batch payments, subscription model, facilitator network |

## Team

### Himess — Founder & Developer

- 5+ years crypto/blockchain development
- 80+ merged PRs: reth, revm, Base, Optimism, Miden VM, Celestia
- Zama Developer Program participant — FHEVM Bootcamp curriculum (328 tests, 20 modules)
- Arc x Lablab AI Hackathon Winner — ArcPay SDK
- PrivAgent — ZK privacy protocol on Base (282 tests, V4.4)
- MixVM — Cross-chain privacy bridge (CCTP V2 + LayerZero)

## The Ask

**What we've built (V1.0 + V1.1 — complete):**
- ConfidentialPaymentPool with FHE encrypted balances and silent failure pattern
- TypeScript SDK: payment handler, paywall middleware, auto-402 fetch, facilitator server
- Agent integrations: Virtuals GAME (5 functions), OpenClaw (6 scripts), ElizaOS (3 actions)
- ERC-8004 Level 1 integration
- React frontend demo
- 210+ tests, V1.1 audited, deployed on Sepolia

**What we'll build next:**
1. Ethereum mainnet deployment with professional audit
2. L2 deployment (Base, Arbitrum) for lower gas costs
3. Decryption gateway for browser-friendly balance checking
4. Facilitator network for privacy-as-a-service

---

*FHE x402 is licensed under the Business Source License 1.1.
Converts to GPL-2.0 on March 1, 2030.*
