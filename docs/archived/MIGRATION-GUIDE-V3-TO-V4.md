# MARC Protocol — Migration Guide: V4.2 to V4.3

## Overview

V4.3 introduces **batch prepayment** — agents can prepay for multiple API requests in a single on-chain transaction and then consume credits without per-request on-chain verification. This reduces gas costs and latency for high-frequency API access.

V4.3 also adds the `AgentReputationRegistry`, `AgentIdentityRegistry`, `MARCTimelock`, nonce cancellation, and Redis-backed batch credit persistence.

This guide covers what you need to change to adopt V4.3 features.

---

## Breaking Changes

None. V4.3 is fully backward-compatible with V4.2. Existing `fhePaywall()` middleware and `createPayment()` / `createSingleTxPayment()` flows continue to work unchanged.

---

## New Contract: recordBatchPayment()

The `X402PaymentVerifier` contract gains a new function for batch prepayment nonce recording.

**Before (V4.2) — single payment only:**

```solidity
// One nonce per request
verifier.recordPayment(server, nonce, minPrice);
```

**After (V4.3) — batch prepayment option:**

```solidity
// Prepay for 100 requests at 0.05 USDC each
verifier.recordBatchPayment(server, nonce, 100, 50000);
```

The batch function emits a `BatchPaymentRecorded` event instead of `PaymentVerified`:

```solidity
event BatchPaymentRecorded(
    address indexed payer,
    address indexed server,
    bytes32 indexed nonce,
    uint32 requestCount,
    uint64 pricePerRequest
);
```

**Overflow protection:** `requestCount * pricePerRequest` is checked to fit within `uint64`. The call reverts with `BatchOverflow` if it does not.

---

## New Contract Feature: Nonce Cancellation

V4.3 adds the ability to cancel unused nonces:

```solidity
// Cancel a nonce you previously recorded
verifier.cancelNonce(nonce);
```

Only the address that originally recorded the nonce (tracked in `nonceOwners` mapping) can cancel it. This is useful when off-chain service delivery fails after nonce recording.

---

## New SDK: fheBatchPaywall() Middleware

**Before (V4.2) — per-request payment:**

```typescript
import { fhePaywall } from "fhe-x402-sdk";

app.get("/api/data", fhePaywall({
  price: "50000",
  asset: "USDC",
  tokenAddress: "0x...",
  verifierAddress: "0x...",
  recipientAddress: "0x...",
  rpcUrl: "https://...",
}), handler);
```

**After (V4.3) — batch prepayment support:**

```typescript
import { fheBatchPaywall } from "fhe-x402-sdk";

app.get("/api/data", fheBatchPaywall({
  price: "50000",        // price per request (used for validation)
  asset: "USDC",
  tokenAddress: "0x...",
  verifierAddress: "0x...",
  recipientAddress: "0x...",
  rpcUrl: "https://...",
}), handler);
```

`fheBatchPaywall()` accepts the same `FhePaywallConfig` as `fhePaywall()`. It handles both single and batch payments:

- If the `Payment` header contains `requestCount` and `pricePerRequest` fields, it treats it as a batch payment
- If not, it falls back to single-payment verification (identical to `fhePaywall()`)

**Important:** Each `fheBatchPaywall()` instance maintains its own isolated batch credit store. This prevents cross-route credit consumption (e.g., buying cheap credits on `/api/basic` and using them on `/api/premium`).

---

## New SDK: createBatchPayment()

**Before (V4.2) — client pays per request:**

```typescript
const handler = new FhePaymentHandler(signer, fhevmInstance);
const result = await handler.createPayment(requirements);
// result.paymentHeader -> use in Payment header
```

**After (V4.3) — client prepays for N requests:**

```typescript
const handler = new FhePaymentHandler(signer, fhevmInstance);
const result = await handler.createBatchPayment(
  requirements,
  100,       // requestCount
  "50000"    // pricePerRequest (0.05 USDC)
);

// First request: sends full batch payment header
// result.paymentHeader contains requestCount + pricePerRequest

// Subsequent requests: reuse same header (nonce stays the same)
fetch(url, { headers: { Payment: result.paymentHeader } });
```

**FheBatchPaymentResult:**

```typescript
interface FheBatchPaymentResult {
  paymentHeader: string;     // base64 JSON with batch fields
  txHash: string;            // confidentialTransfer TX
  verifierTxHash: string;    // recordBatchPayment TX
  nonce: string;             // bytes32 hex
  requestCount: number;      // prepaid request count
  pricePerRequest: string;   // USDC per request (6 decimals)
}
```

---

## New Response Headers

When using `fheBatchPaywall()`, the server returns additional headers:

| Header | Description |
|--------|-------------|
| `X-Batch-Credits-Remaining` | Number of remaining prepaid credits |
| `X-Batch-Credits-Expiry-Warning` | Warning string when credits expire within 1 hour |
| `X-Request-Id` | Unique request ID for correlation (also in `fhePaywall`) |
| `X-Payment-TxHash` | The payment transaction hash |

---

## New Batch Payment Payload

The `Payment` header for batch payments is a base64-encoded JSON object with two additional fields:

**Single payment (V4.2):**

```json
{
  "scheme": "fhe-confidential-v1",
  "txHash": "0x...",
  "verifierTxHash": "0x...",
  "nonce": "0x...",
  "from": "0x...",
  "chainId": 11155111,
  "signature": "0x..."
}
```

**Batch payment (V4.3):**

```json
{
  "scheme": "fhe-confidential-v1",
  "txHash": "0x...",
  "verifierTxHash": "0x...",
  "nonce": "0x...",
  "from": "0x...",
  "chainId": 11155111,
  "requestCount": 100,
  "pricePerRequest": "50000",
  "signature": "0x..."
}
```

The middleware detects batch mode by checking for the presence of `requestCount` (number) and `pricePerRequest` (string).

---

## Production: Redis Batch Credit Store

The in-memory batch credit store works for single-instance servers. For multi-instance or production deployments, use `RedisBatchCreditStore`:

```typescript
import Redis from "ioredis";
import { RedisBatchCreditStore } from "fhe-x402-sdk";

const redis = new Redis(process.env.REDIS_URL);
const batchStore = new RedisBatchCreditStore(redis, {
  prefix: "fhe-x402:batch:",    // default
  ttlSeconds: 604800,           // 7 days (default)
});
```

The Redis store uses atomic `DECR` for credit consumption when available, preventing race conditions in multi-instance deployments.

---

## New Contracts (Optional Adoption)

V4.3 also introduces three new contracts that can be adopted independently:

### AgentIdentityRegistry

On-chain identity for AI agents:

```typescript
import { registerAgent, getAgent, agentOf } from "fhe-x402-sdk";

await registerAgent(signer, registryAddress, "https://example.com/agent.json");
const agent = await getAgent(provider, registryAddress, 1);
const agentId = await agentOf(provider, registryAddress, walletAddress);
```

### AgentReputationRegistry

On-chain feedback with proof-of-payment:

```typescript
import { giveFeedback, getReputationSummary } from "fhe-x402-sdk";

// proofOfPayment must be a valid nonce from X402PaymentVerifier
await giveFeedback(signer, reputationAddress, agentId, 90, tags, nonce);
const summary = await getReputationSummary(provider, reputationAddress, agentId);
```

### MARCTimelock

Governance timelock for ConfidentialUSDC and ACP ownership:

```solidity
MARCTimelock(172800, [safeAddress], [safeAddress], address(0))
```

---

## Checklist

- [ ] Update `X402PaymentVerifier` if redeploying (or use existing — V4.3 is additive)
- [ ] Replace `fhePaywall()` with `fheBatchPaywall()` on routes that benefit from batch payments
- [ ] Update client code to use `createBatchPayment()` for high-frequency API access
- [ ] (Production) Add `RedisBatchCreditStore` for multi-instance batch credit persistence
- [ ] (Optional) Deploy `AgentIdentityRegistry` and `AgentReputationRegistry`
- [ ] (Optional) Deploy `MARCTimelock` and transfer contract ownership for governance
