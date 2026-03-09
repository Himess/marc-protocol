# fhe-x402-sdk

TypeScript SDK for the FHE x402 payment protocol. Encrypts payment amounts with Fully Homomorphic Encryption (FHE) via [Zama's fhevmjs](https://docs.zama.ai/fhevm), so on-chain balances and transfer amounts remain confidential.

## Install

```bash
npm install fhe-x402-sdk
```

Peer dependency:
```bash
npm install fhevmjs
```

## Quick Start

### Client: Pay for a 402 resource

```typescript
import { fheFetch } from "fhe-x402-sdk";
import { Wallet, JsonRpcProvider } from "ethers";
import { initFhevm, createInstance } from "fhevmjs";

await initFhevm();
const fhevmInstance = await createInstance({ chainId: 11155111 });
const provider = new JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");
const signer = new Wallet(process.env.PRIVATE_KEY!, provider);

const response = await fheFetch("https://api.example.com/premium", {
  poolAddress: "0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73",
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  signer,
  fhevmInstance,
  maxPayment: 5_000_000n, // 5 USDC max
  timeoutMs: 30_000,
  maxRetries: 2,
  retryDelayMs: 1_000,
});

const data = await response.json();
```

### Server: Paywall middleware (Express)

```typescript
import express from "express";
import { fhePaywall } from "fhe-x402-sdk";

const app = express();

app.use(
  "/api/premium",
  fhePaywall({
    price: "1000000", // 1 USDC
    asset: "USDC",
    poolAddress: "0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73",
    recipientAddress: "0xYourAddress",
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  })
);

app.get("/api/premium", (req, res) => {
  res.json({ data: "premium content", paidBy: req.paymentInfo?.from });
});
```

## API

### `fheFetch(url, options): Promise<Response>`

x402-aware fetch. Automatically handles 402 responses by encrypting payment via fhevmjs, calling `pool.pay()` on-chain, and retrying with the Payment header.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `poolAddress` | `string` | required | ConfidentialPaymentPool address |
| `rpcUrl` | `string` | required | Ethereum RPC URL |
| `signer` | `ethers.Signer` | required | Wallet for signing transactions |
| `fhevmInstance` | `FhevmInstance` | required | fhevmjs instance for FHE encryption |
| `maxPayment` | `bigint` | - | Maximum payment amount (6 decimals) |
| `allowedNetworks` | `string[]` | - | CAIP-2 network filter (e.g. `["eip155:11155111"]`) |
| `dryRun` | `boolean` | `false` | Return 402 without paying |
| `timeoutMs` | `number` | `30000` | HTTP request timeout (ms) |
| `maxRetries` | `number` | `0` | Retry attempts after payment |
| `retryDelayMs` | `number` | `1000` | Base delay between retries (linear backoff) |
| `memo` | `string` | `0x0...0` | Optional bytes32 memo attached to payment |

### `createFheFetch(options): (url, init?) => Promise<Response>`

Creates a bound fetch function with pre-configured options.

```typescript
const secureFetch = createFheFetch({ poolAddress, rpcUrl, signer, fhevmInstance });
const res = await secureFetch("https://api.example.com/data");
```

### `FhePaymentHandler`

Low-level handler for parsing 402 responses and creating payments.

```typescript
import { FhePaymentHandler } from "fhe-x402-sdk";

const handler = new FhePaymentHandler(signer, fhevmInstance, {
  maxPayment: 10_000_000n,
  allowedNetworks: ["eip155:11155111"],
  memo: "0x" + "ab".repeat(32),
});

// Parse 402 response
const requirements = await handler.parsePaymentRequired(response);

// Select matching requirement
const selected = handler.selectRequirement(requirements.accepts);

// Create payment (encrypts + sends tx)
const result = await handler.createPayment(selected);
// result.txHash, result.nonce, result.paymentHeader
```

### `fhePaywall(config): express.RequestHandler`

Express middleware that returns 402 with FHE payment requirements, then verifies `PaymentExecuted` events on-chain.

| Config | Type | Default | Description |
|--------|------|---------|-------------|
| `price` | `number \| string` | required | USDC amount (6 decimals) |
| `asset` | `string` | required | Token symbol |
| `poolAddress` | `string` | required | Pool contract address |
| `recipientAddress` | `string` | required | Payment recipient |
| `rpcUrl` | `string` | required | Ethereum RPC URL |
| `chainId` | `number` | `11155111` | Chain ID |
| `maxTimeoutSeconds` | `number` | `300` | Payment timeout |
| `maxRateLimit` | `number` | `60` | Requests per window |
| `rateLimitWindowMs` | `number` | `60000` | Rate limit window |
| `minConfirmations` | `number` | `1` | Block confirmations required |
| `nonceStore` | `NonceStore` | in-memory | Nonce persistence backend |

### `createFacilitatorServer(config): Promise<express.Application>`

Creates a standalone facilitator server with `/info`, `/verify`, and `/health` endpoints.

```typescript
import { createFacilitatorServer } from "fhe-x402-sdk";

const app = await createFacilitatorServer({
  poolAddress: "0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73",
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  apiKey: process.env.API_KEY,
});

app.listen(3001);
```

### ERC-8004 Helpers

```typescript
import { fhePaymentMethod, fhePaymentProof } from "fhe-x402-sdk";

// For agent registration files
const method = fhePaymentMethod({
  poolAddress: "0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73",
  facilitatorUrl: "https://facilitator.example.com",
});

// For feedback proof-of-payment
const proof = fhePaymentProof(nonce, poolAddress);
```

## Error Handling

The SDK provides structured error classes for programmatic error handling:

```typescript
import {
  FheX402Error,
  PaymentError,
  EncryptionError,
  TimeoutError,
  NetworkError,
  FheErrorCode,
} from "fhe-x402-sdk";

try {
  await fheFetch(url, options);
} catch (err) {
  if (err instanceof PaymentError) {
    console.error("Payment failed:", err.code, err.details);
  } else if (err instanceof EncryptionError) {
    console.error("FHE encryption failed:", err.message);
  } else if (err instanceof TimeoutError) {
    console.error("Request timed out:", err.details?.timeoutMs);
  } else if (err instanceof NetworkError) {
    console.error("Network error after retries:", err.details?.retries);
  }
}
```

| Error Class | Code | When |
|-------------|------|------|
| `PaymentError` | `PAYMENT_FAILED` | On-chain payment TX reverted |
| `EncryptionError` | `ENCRYPTION_FAILED` | fhevmjs encryption failed |
| `VerificationError` | `VERIFICATION_FAILED` | Event verification failed |
| `TimeoutError` | `TIMEOUT` | HTTP request timeout |
| `NetworkError` | `NETWORK_ERROR` | All retry attempts exhausted |

## Custom Nonce Store

The default in-memory nonce store doesn't survive server restarts. For production, implement the `NonceStore` interface:

```typescript
import type { NonceStore } from "fhe-x402-sdk";

class RedisNonceStore implements NonceStore {
  constructor(private redis: Redis) {}

  async check(nonce: string): Promise<boolean> {
    return !(await this.redis.exists(`nonce:${nonce}`));
  }

  async add(nonce: string): Promise<void> {
    await this.redis.set(`nonce:${nonce}`, "1", "EX", 86400);
  }

  async checkAndAdd(nonce: string): Promise<boolean> {
    const result = await this.redis.set(`nonce:${nonce}`, "1", "EX", 86400, "NX");
    return result === "OK";
  }
}
```

## Contract ABI

The SDK exports `POOL_ABI` with the full ConfidentialPaymentPool V1.2 interface:

```typescript
import { POOL_ABI } from "fhe-x402-sdk";
```

## Tests

```bash
cd sdk && npx vitest run
```

85 tests covering handler, middleware, fetch, facilitator, ERC-8004, and error classes.

## License

BUSL-1.1
