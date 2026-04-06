# marc-protocol-sdk

TypeScript SDK for the MARC Protocol — FHE-powered x402 payment protocol. Encrypts payment amounts with Fully Homomorphic Encryption (FHE) via [Zama's @zama-fhe/relayer-sdk](https://docs.zama.ai/fhevm), so on-chain transfer amounts remain confidential.

## Install

```bash
npm install marc-protocol-sdk
```

Peer dependency (optional — needed for real FHE encryption):
```bash
npm install @zama-fhe/relayer-sdk
```

## Quick Start

### Client: Pay for a 402 resource

```typescript
import { fheFetch } from "marc-protocol-sdk";
import { Wallet, JsonRpcProvider } from "ethers";
import { createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/node";

const fhevmInstance = await createInstance({ ...SepoliaConfig, network: "https://ethereum-sepolia-rpc.publicnode.com" });
const provider = new JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");
const signer = new Wallet(process.env.PRIVATE_KEY!, provider);

const response = await fheFetch("https://api.example.com/premium", {
  tokenAddress: "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D",
  verifierAddress: "0x4503A7aee235aBD10e6064BBa8E14235fdF041f4",
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
import { fhePaywall } from "marc-protocol-sdk";

const app = express();

app.use(
  "/api/premium",
  fhePaywall({
    price: "1000000", // 1 USDC (6 decimals)
    asset: "USDC",
    tokenAddress: "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D",
    verifierAddress: "0x4503A7aee235aBD10e6064BBa8E14235fdF041f4",
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

x402-aware fetch. Automatically handles 402 responses by encrypting payment via FHE, calling `confidentialTransfer()` + `recordPayment()` on-chain, and retrying with the Payment header.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `tokenAddress` | `string` | required | ConfidentialUSDC (ERC-7984) address |
| `verifierAddress` | `string` | required | X402PaymentVerifier address |
| `rpcUrl` | `string` | required | Ethereum RPC URL |
| `signer` | `ethers.Signer` | required | Wallet for signing transactions |
| `fhevmInstance` | `FhevmInstance` | required | @zama-fhe/relayer-sdk instance |
| `maxPayment` | `bigint` | - | Maximum payment amount (6 decimals) |
| `allowedNetworks` | `string[]` | - | CAIP-2 network filter (e.g. `["eip155:11155111"]`) |
| `dryRun` | `boolean` | `false` | Return 402 without paying |
| `timeoutMs` | `number` | `30000` | HTTP request timeout (ms) |
| `maxRetries` | `number` | `0` | Retry attempts after payment |
| `retryDelayMs` | `number` | `1000` | Base delay between retries (exponential backoff) |
| `preferSingleTx` | `boolean` | `true` | Use single-TX flow via payAndRecord() (Zama operator pattern). Set to `false` for legacy 2-TX flow. |

### `createFheFetch(options): (url, init?) => Promise<Response>`

Creates a bound fetch function with pre-configured options.

```typescript
const secureFetch = createFheFetch({ tokenAddress, verifierAddress, rpcUrl, signer, fhevmInstance });
const res = await secureFetch("https://api.example.com/data");
```

### `FhePaymentHandler`

Low-level handler for parsing 402 responses and creating payments.

```typescript
import { FhePaymentHandler } from "marc-protocol-sdk";

const handler = new FhePaymentHandler(signer, fhevmInstance, {
  maxPayment: 10_000_000n,
  allowedNetworks: ["eip155:11155111"],
});

// Parse 402 response
const requirements = await handler.parsePaymentRequired(response);

// Select matching requirement
const selected = handler.selectRequirement(requirements.accepts);

// Create payment (encrypts + sends 2 TXs: confidentialTransfer + recordPayment)
const result = await handler.createPayment(selected);
// result.txHash, result.verifierTxHash, result.nonce, result.paymentHeader
```

### `fhePaywall(config): express.RequestHandler`

Express middleware that returns 402 with FHE payment requirements, then verifies payment on-chain via nonce + event checks.

| Config | Type | Default | Description |
|--------|------|---------|-------------|
| `price` | `number \| string` | required | USDC amount (6 decimals) |
| `asset` | `string` | required | Token symbol |
| `tokenAddress` | `string` | required | ConfidentialUSDC address |
| `verifierAddress` | `string` | required | X402PaymentVerifier address |
| `recipientAddress` | `string` | required | Payment recipient |
| `rpcUrl` | `string` | required | Ethereum RPC URL |
| `chainId` | `number` | `11155111` | Chain ID |
| `maxTimeoutSeconds` | `number` | `300` | Payment timeout |
| `nonceStore` | `NonceStore` | in-memory | Nonce persistence backend |

### `createFacilitatorServer(config): Promise<express.Application>`

Creates a standalone facilitator server with `/info`, `/verify`, and `/health` endpoints.

```typescript
import { createFacilitatorServer } from "marc-protocol-sdk";

const app = await createFacilitatorServer({
  tokenAddress: "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D",
  verifierAddress: "0x4503A7aee235aBD10e6064BBa8E14235fdF041f4",
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  apiKey: process.env.API_KEY,
});

app.listen(3001);
```

### ERC-8004 Helpers

```typescript
import { fhePaymentMethod, fhePaymentProof } from "marc-protocol-sdk";

// For agent registration files
const method = fhePaymentMethod({
  tokenAddress: "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D",
  verifierAddress: "0x4503A7aee235aBD10e6064BBa8E14235fdF041f4",
  facilitatorUrl: "https://facilitator.example.com",
});

// For feedback proof-of-payment
const proof = fhePaymentProof(nonce, verifierAddress);
```

### ERC-8183 Agentic Commerce

```typescript
import { createJob, connectACP, fundJob, completeJob } from "marc-protocol-sdk";

const acp = connectACP(acpAddress, signer);
const jobId = await createJob(acp, provider, evaluator, expiry, "data-analysis", hook);
await fundJob(acp, jobId, budget, usdcContract);
await completeJob(acp, jobId, "delivered");
// 99% to provider, 1% to protocol treasury
```

## Error Handling

```typescript
import {
  FheX402Error,
  PaymentError,
  EncryptionError,
  TimeoutError,
  NetworkError,
  FheErrorCode,
} from "marc-protocol-sdk";

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
| `EncryptionError` | `ENCRYPTION_FAILED` | FHE encryption failed |
| `VerificationError` | `VERIFICATION_FAILED` | Event verification failed |
| `TimeoutError` | `TIMEOUT` | HTTP request timeout |
| `NetworkError` | `NETWORK_ERROR` | All retry attempts exhausted |

## Production Nonce Store

```typescript
import { RedisNonceStore } from "marc-protocol-sdk";

const nonceStore = new RedisNonceStore(redisClient, { prefix: "marc:", ttlSeconds: 86400 });

app.use("/api", fhePaywall({ ...config, nonceStore }));
```

## Contract ABIs

```typescript
import { TOKEN_ABI, VERIFIER_ABI } from "marc-protocol-sdk";
```

- `TOKEN_ABI` — ConfidentialUSDC (ERC-7984 + wrap/unwrap + confidentialTransfer)
- `VERIFIER_ABI` — X402PaymentVerifier (recordPayment + batch + IERC7984Receiver)

## Tests

```bash
cd sdk && npx vitest run
```

173 tests covering handler, middleware, fetch, facilitator, ERC-8004, ERC-8183, silent failure guard, Redis stores, and error classes.

## License

BUSL-1.1
