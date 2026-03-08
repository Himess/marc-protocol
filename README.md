# FHE x402 Payment Protocol

Privacy-preserving HTTP payment protocol using Fully Homomorphic Encryption (FHE) on Ethereum. Agents pay for API access with encrypted USDC amounts — servers verify on-chain events without seeing balances.

**Scheme:** `fhe-confidential-v1` | **Chain:** Ethereum Sepolia | **Tests:** 224 (86 contract + 13 on-chain + 72 SDK + 28 Virtuals + 25 OpenClaw)

> *"Crypto privacy is needed if you want to make API calls without compromising the information of your access patterns. Even with a local AI agent, you can learn a lot about what someone is doing if you see all of their search engine calls. [...] providers will demand an anti-DoS mechanism, and realistically payment per call. By default that will be credit card or some corposlop stablecoin thing — so we need crypto privacy."*
>
> — [Vitalik Buterin, March 2026](https://x.com/VitalikButerin/status/2030510783134871594)

## Architecture

```
Client (Agent A)              Server (Agent B)
    |                              |
    |-- GET /api/data ------------>|
    |<--- 402 + requirements ------|
    |                              |
    |  fhevmjs.encrypt(amount)     |
    |  pool.pay(to, enc, proof,    |
    |           minPrice, nonce)   |
    |                              |
    |-- Retry + Payment header --->|
    |   [Server verifies event]    |
    |<--- 200 + data --------------|
```

**Key properties:**
- Encrypted amounts (FHE euint64) — observers can't see payment values
- Public participants — sender/recipient addresses are visible (x402 requirement)
- Silent failure — insufficient balance transfers 0 (no revert = no info leak)
- No relayer — client pays gas directly (FHE encrypt is instant)
- Event-based verification — server checks `PaymentExecuted` on-chain

## Contracts (Sepolia)

| Contract | Address |
|----------|---------|
| MockUSDC | `0x229146B746cf3A314dee33f08b84f8EFd5F314F4` |
| ConfidentialPaymentPool | `0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73` |

Both verified on [Etherscan](https://sepolia.etherscan.io).

## Quick Start

```bash
# Install
npm install

# Compile contracts
npx hardhat compile

# Run contract tests (86 mock tests — fast, no ETH needed)
npx hardhat test

# Run Sepolia on-chain tests (13 tests — real FHE, requires funded wallet)
PRIVATE_KEY=0x... SEPOLIA_RPC_URL=https://... npm run test:sepolia

# Build + test SDK (72 tests)
cd sdk && npm install && npx tsup && npx vitest run

# Test Virtuals plugin (28 tests)
cd packages/virtuals-plugin && npm install && npx vitest run

# Test OpenClaw skill (25 tests)
cd packages/openclaw-skill && npm install && npx vitest run

# Build frontend
cd frontend && npm install && npx vite build
```

## Project Structure

```
fhe-x402/
├── contracts/
│   ├── ConfidentialPaymentPool.sol   # Core pool (deposit/pay/withdraw)
│   ├── interfaces/
│   │   └── IConfidentialPaymentPool.sol
│   └── mocks/
│       └── MockUSDC.sol
├── test/                             # 86 mock + 13 on-chain tests
│   ├── Pool.deposit.test.ts
│   ├── Pool.pay.test.ts
│   ├── Pool.withdraw.test.ts
│   ├── Pool.fee.test.ts
│   ├── Pool.edge.test.ts
│   ├── Demo.e2e.test.ts
│   └── Sepolia.onchain.test.ts       # Real FHE on Sepolia (13 tests)
├── sdk/
│   ├── src/
│   │   ├── types.ts                  # FHE x402 types + NonceStore
│   │   ├── fhePaymentHandler.ts      # Client: encrypt + pay
│   │   ├── fhePaywallMiddleware.ts   # Server: Express paywall
│   │   ├── fheFetch.ts              # Client: auto-402 fetch
│   │   ├── facilitator.ts           # Facilitator server
│   │   └── erc8004/index.ts         # ERC-8004 helpers
│   └── tests/                        # 72 SDK tests
├── packages/
│   ├── virtuals-plugin/              # Virtuals GAME plugin (28 tests)
│   │   ├── src/fhePlugin.ts          # 5 GameFunctions
│   │   └── tests/plugin.test.ts
│   └── openclaw-skill/               # OpenClaw skill (25 tests)
│       ├── scripts/                   # 6 CLI scripts
│       └── tests/scripts.test.ts
├── examples/
│   └── eliza-plugin/                 # ElizaOS example (3 actions)
├── frontend/                         # React demo app
│   └── src/
│       ├── App.tsx
│       └── components/
├── demo/                             # Terminal demos
│   ├── agent-demo.ts                 # Full flow demo (ANSI colors)
│   ├── agent-buyer.ts                # Client buying API data
│   └── agent-seller.ts               # Server with FHE paywall
├── docs/
│   ├── LIGHTPAPER.md                 # Investor/jury-ready paper
│   ├── PROTOCOL.md                   # Technical specification
│   ├── TODO.md                       # Development tracker
│   └── ROADMAP.md                    # V1.0 → V2.1 milestones
└── deploy/
    └── 01_deploy_pool.ts
```

## Contract: ConfidentialPaymentPool

### Functions

| Function | Description |
|----------|-------------|
| `deposit(uint64 amount)` | Deposit plaintext USDC, credited as encrypted balance |
| `pay(to, encAmount, proof, minPrice, nonce)` | Encrypted agent-to-agent payment |
| `requestWithdraw(encAmount, proof)` | Step 1: Request async decryption |
| `cancelWithdraw()` | Cancel pending withdrawal, refund to balance |
| `finalizeWithdraw(clearAmount, decryptionProof)` | Step 2: Finalize with KMS proof |
| `requestBalance()` | Request balance snapshot decryption |
| `transferOwnership(newOwner)` | Start 2-step ownership transfer |
| `acceptOwnership()` | Accept ownership transfer |

### Fee Structure

- **Rate:** 0.1% (10 bps)
- **Minimum:** 0.01 USDC (10,000 micro-USDC)
- **Breakeven:** 10 USDC (below: flat fee, above: percentage)
- **Applied on:** deposit, pay (from minPrice), withdraw

### Silent Failure Pattern

FHE encrypted booleans cannot be branched on in Solidity. When a payment fails (insufficient balance or amount < minPrice), the contract transfers 0 instead of reverting. This prevents leaking balance information.

**Implication:** `PaymentExecuted` events emit even on 0-transfer. Servers bear bounded risk of one free API response per failed payment.

## SDK

### Client (Agent paying for API)

```typescript
import { FhePaymentHandler, fheFetch, createFheFetch } from "fhe-x402-sdk";

// Auto-handle 402 responses
const response = await fheFetch("https://api.example.com/data", {
  poolAddress: "0x...",
  rpcUrl: "https://sepolia.infura.io/v3/...",
  signer: wallet,
  fhevmInstance: fhevm,
});
```

### Server (API behind paywall)

```typescript
import { fhePaywall } from "fhe-x402-sdk";
import express from "express";

const app = express();

app.use("/api/premium", fhePaywall({
  price: "1000000",        // 1 USDC
  asset: "USDC",
  poolAddress: "0x...",
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
  poolAddress: "0x...",
  rpcUrl: "https://sepolia.infura.io/v3/...",
  apiKey: process.env.API_KEY,
});

app.listen(3001);
// GET  /info    — scheme info
// POST /verify  — verify PaymentExecuted event
// GET  /health  — health check
```

### ERC-8004 Integration

```typescript
import { fhePaymentMethod, fhePaymentProof } from "fhe-x402-sdk";

// For agent registration files
const method = fhePaymentMethod({ poolAddress: "0x..." });

// For feedback submission (proof-of-payment)
const proof = fhePaymentProof(nonce, poolAddress);
```

### NonceStore Interface

The default in-memory nonce store doesn't survive server restarts. For production, implement `NonceStore`:

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

## Agent Framework Integrations

### Virtuals GAME Plugin

```typescript
import { FhePlugin } from "@fhe-x402/virtuals-plugin";
import { initFhevm, createInstance } from "fhevmjs";

// Initialize fhevmjs
await initFhevm();
const fhevmInstance = await createInstance({
  chainId: 11155111,
  networkUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  gatewayUrl: "https://gateway.sepolia.zama.ai",
});

const plugin = new FhePlugin({
  credentials: {
    privateKey: process.env.PRIVATE_KEY!,
    poolAddress: "0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73",
    fhevmInstance,
  },
});

const worker = plugin.getWorker();
// 5 GameFunctions: fhe_deposit, fhe_pay, fhe_withdraw, fhe_balance, fhe_info
```

### OpenClaw Skill

```bash
# Balance check
npx tsx scripts/balance.ts

# Deposit USDC
npx tsx scripts/deposit.ts --amount 10

# Encrypted payment
npx tsx scripts/pay.ts --to 0x... --amount 1

# Request withdrawal
npx tsx scripts/withdraw.ts --amount 5

# Wallet info
npx tsx scripts/info.ts
```

### ElizaOS Plugin

See `examples/eliza-plugin/` for a complete ElizaOS integration example with 3 actions: `FHE_PAY`, `FHE_BALANCE`, `FHE_DEPOSIT`.

## Demo

```bash
# Terminal demo (requires funded Sepolia wallet)
PRIVATE_KEY=0x... npx tsx demo/agent-demo.ts

# Run seller server
npx tsx demo/agent-seller.ts

# Run buyer client (in another terminal)
PRIVATE_KEY=0x... npx tsx demo/agent-buyer.ts
```

## Deploy

```bash
cp .env.example .env
# Edit .env with your PRIVATE_KEY and RPC URL

npx hardhat deploy --network sepolia
npx hardhat verify --network sepolia DEPLOYED_ADDRESS USDC_ADDRESS TREASURY_ADDRESS
```

## Security

### Audit Status

V1.1 audited — 224 tests (including 13 real on-chain FHE tests), all critical/high findings fixed:

- **C-1 Fixed:** Price comparison corrected (`>=` not `<=`) in middleware
- **C-2 Fixed:** `minPrice >= MIN_PROTOCOL_FEE` enforced to prevent FHE underflow
- **C-3 Fixed:** `amount >= MIN_PROTOCOL_FEE` enforced in deposit
- **H-1 Fixed:** `cancelWithdraw()` added to escape silent failure lock
- **H-2 Fixed:** `requestBalance()` creates snapshot, not exposing live handle
- **H-3 Fixed:** 2-step `transferOwnership` / `acceptOwnership`
- **H-4 Fixed:** `NonceStore` interface for persistent nonce tracking
- **H-5 Fixed:** Chain ID verification in middleware
- **M-2 Fixed:** Configurable `minConfirmations` for block depth check
- **M-4 Fixed:** `minPrice >= MIN_PROTOCOL_FEE` validation
- **M-5 Fixed:** Treasury cannot be payment recipient

### Known Limitations

1. **Silent failure event emission** — `PaymentExecuted` fires on 0-transfer (inherent to FHE)
2. **In-memory rate limiter** — Resets on server restart (use external store in production)
3. **Mock KMS in tests** — `finalizeWithdraw` uses mock proofs; production requires real KMS

## Tech Stack

- Solidity 0.8.27 + `@fhevm/solidity@0.10` + `@fhevm/hardhat-plugin@0.4.0`
- TypeScript SDK with `ethers@6` + `tsup` (ESM/CJS)
- Hardhat with viaIR optimizer, Cancun EVM
- Virtuals Protocol GAME SDK
- React + Vite (frontend demo)

## License

BUSL-1.1 — converts to GPL-2.0 on March 1, 2030.
