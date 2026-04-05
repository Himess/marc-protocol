# MARC Protocol — API Reference

## Smart Contracts

All contracts target Solidity 0.8.27 and are deployed on Ethereum Sepolia.

---

### ConfidentialUSDC

> `contracts/ConfidentialUSDC.sol`

ERC-7984 confidential USDC token. Wraps USDC into FHE-encrypted cUSDC for private transfers.
Inherits from `ERC7984`, `ERC7984ERC20Wrapper`, `Ownable2Step`, `Pausable`, `ReentrancyGuard`.

**Constants**

| Name | Value | Description |
|------|-------|-------------|
| `FEE_BPS` | 10 | Protocol fee: 0.1% |
| `BPS` | 10,000 | Basis points denominator |
| `MIN_PROTOCOL_FEE` | 10,000 | Minimum fee: 0.01 USDC (in micro-USDC) |
| `MAX_FEE_BPS` | 100 | Governance safety limit: 1% max |

**Constructor**

```solidity
constructor(IERC20 _usdc, address _treasury)
```
- `_usdc` — USDC ERC-20 address (must have 6 decimals)
- `_treasury` — Fee treasury address (cannot be zero)
- Reverts: `ZeroAddress`, `InvalidDecimals`

**Public / External Functions**

| Function | Modifiers | Description |
|----------|-----------|-------------|
| `wrap(address to, uint256 amount)` | `nonReentrant`, `whenNotPaused` | Wrap USDC into cUSDC. Fee deducted from amount. Amount must exceed `MIN_PROTOCOL_FEE`. |
| `finalizeUnwrap(euint64 burntAmount, uint64 burntAmountCleartext, bytes decryptionProof)` | `nonReentrant`, `whenNotPaused` | Complete unwrap after Zama KMS decryption. Deducts fee from USDC payout. |
| `confidentialTransferAndCall(address to, externalEuint64 encryptedAmount, bytes inputProof, bytes data)` | `nonReentrant`, `whenNotPaused` | Transfer cUSDC and call IERC7984Receiver callback on recipient. Reverts on self-transfer. |
| `confidentialTransfer(address to, externalEuint64 encryptedAmount, bytes inputProof)` | `whenNotPaused` | Transfer encrypted cUSDC (new encryption). |
| `confidentialTransfer(address to, euint64 amount)` | `whenNotPaused` | Transfer encrypted cUSDC (existing handle). |
| `confidentialTransferFrom(address from, address to, externalEuint64 encryptedAmount, bytes inputProof)` | `whenNotPaused` | Transfer from another address (new encryption). Requires operator approval. |
| `confidentialTransferFrom(address from, address to, euint64 amount)` | `whenNotPaused` | Transfer from another address (existing handle). |
| `setOperator(address operator, uint48 until)` | `whenNotPaused` | Set ERC-7984 operator approval with expiry timestamp. |
| `setTreasury(address _treasury)` | `onlyOwner` | Update fee treasury address. |
| `treasuryWithdraw()` | `nonReentrant` | Withdraw accumulated USDC fees to treasury. Callable by treasury or owner. |
| `pause()` | `onlyOwner` | Emergency pause all operations. |
| `unpause()` | `onlyOwner` | Resume operations. |

**View Functions**

| Function | Returns | Description |
|----------|---------|-------------|
| `treasury()` | `address` | Fee treasury address |
| `accumulatedFees()` | `uint256` | Plaintext USDC fees available for withdrawal |
| `confidentialBalanceOf(address)` | `bytes32` | Encrypted cUSDC balance handle |
| `underlying()` | `address` | USDC address |
| `rate()` | `uint256` | Conversion rate (always 1 for USDC) |
| `paused()` | `bool` | Whether contract is paused |
| `isOperator(address holder, address spender)` | `bool` | Operator approval status |

**Events**

```solidity
event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
event TreasuryWithdrawn(address indexed treasury, uint256 amount);
event ConfidentialTransfer(address indexed from, address indexed to, bytes32 indexed amount);  // inherited
event OperatorSet(address indexed holder, address indexed operator, uint48 until);  // inherited
event UnwrapRequested(address indexed receiver, bytes32 amount);  // inherited
event UnwrapFinalized(address indexed receiver, bytes32 encryptedAmount, uint64 cleartextAmount);  // inherited
```

**Custom Errors**

`ZeroAddress`, `ZeroAmount`, `DustAmount`, `InvalidDecimals`, `InsufficientFees`, `UnwrapAlreadyRequested`, `TransferCallbackFailed`, `SelfTransfer`

---

### X402PaymentVerifier

> `contracts/X402PaymentVerifier.sol`

On-chain nonce registry for x402 payments. Records single and batch payment nonces. Implements `IERC7984Receiver` for transferAndCall callbacks.

**Constructor**

```solidity
constructor(address _trustedToken)
```
- `_trustedToken` — ConfidentialUSDC contract address (immutable)

**Public / External Functions**

| Function | Modifiers | Description |
|----------|-----------|-------------|
| `recordPayment(address server, bytes32 nonce, uint64 minPrice)` | `whenNotPaused` | Record a single payment nonce. Uses `msg.sender` as payer. |
| `payAndRecord(address token, address server, bytes32 nonce, uint64 minPrice, externalEuint64 encryptedAmount, bytes inputProof)` | `whenNotPaused` | Single-TX: transfer cUSDC + record nonce. Requires operator approval on token. |
| `recordBatchPayment(address server, bytes32 nonce, uint32 requestCount, uint64 pricePerRequest)` | `whenNotPaused` | Record batch prepayment nonce for N future requests. Overflow-checked. |
| `onConfidentialTransferReceived(address operator, address from, euint64 amount, bytes data)` | — | IERC7984Receiver callback. Only callable by `trustedToken`. Decodes `(server, nonce, minPrice)` from data. |
| `cancelNonce(bytes32 nonce)` | — | Cancel an unused nonce. Only callable by original recorder. |
| `pause()` | `onlyOwner` | Emergency pause. |
| `unpause()` | `onlyOwner` | Resume. |

**View Functions**

| Function | Returns | Description |
|----------|---------|-------------|
| `trustedToken()` | `address` | ConfidentialUSDC address (immutable) |
| `usedNonces(bytes32)` | `bool` | Whether a nonce has been used |
| `nonceOwners(bytes32)` | `address` | Address that recorded the nonce |

**Events**

```solidity
event PaymentVerified(address indexed payer, address indexed server, bytes32 indexed nonce, uint64 minPrice);
event PayAndRecordCompleted(address indexed payer, address indexed server, bytes32 indexed nonce, address token, uint64 minPrice);
event BatchPaymentRecorded(address indexed payer, address indexed server, bytes32 indexed nonce, uint32 requestCount, uint64 pricePerRequest);
event NonceCancelled(address indexed payer, bytes32 indexed nonce);
```

**Custom Errors**

`NonceAlreadyUsed`, `ZeroRequestCount`, `UntrustedCaller`, `ZeroMinPrice`, `BatchOverflow`, `ZeroAddress`, `NonceCancellationFailed`

---

### AgenticCommerceProtocol (ACP)

> `contracts/AgenticCommerceProtocol.sol`

ERC-8183 job escrow for agent commerce. Clients lock funds, providers submit work, evaluators approve/reject. Platform fee: 1% on completion.

**Constructor**

```solidity
constructor(IERC20 _paymentToken, address _treasury)
```
- `_paymentToken` — ERC-20 token for payments (must be a contract, not EOA)
- `_treasury` — Platform fee treasury address

**Job Lifecycle**

| Function | Who | Description |
|----------|-----|-------------|
| `createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook)` | Anyone | Create a job. Returns `jobId`. Evaluator required; cannot be self or provider. |
| `createAndFund(address provider, address evaluator, uint256 expiredAt, string description, address hook, uint256 budget)` | Anyone | Create + set budget + fund in one TX. |
| `setProvider(uint256 jobId, address provider)` | Client | Set/update provider on an Open job. |
| `setBudget(uint256 jobId, uint256 amount)` | Client | Set budget on an Open job. |
| `fund(uint256 jobId, uint256 expectedBudget)` | Client | Fund an Open job. `expectedBudget` must match current budget (front-running protection). |
| `submit(uint256 jobId, bytes32 deliverable)` | Provider | Submit deliverable for a Funded job. |
| `complete(uint256 jobId, bytes32 reason)` | Evaluator | Complete a Submitted job. Pays provider (minus 1% fee). |
| `reject(uint256 jobId, bytes32 reason)` | Client or Evaluator | Reject and refund. Client can reject Open/Funded. Evaluator can reject Funded/Submitted. |
| `claimRefund(uint256 jobId)` | Client | Claim refund on expired Funded/Submitted job. |

**Job Statuses:** `Open` -> `Funded` -> `Submitted` -> `Completed` | `Rejected` | `Expired`

**View Functions**

```solidity
function getJob(uint256 jobId) external view returns (Job memory);
```

**Events**

```solidity
event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt);
event ProviderSet(uint256 indexed jobId, address indexed provider);
event BudgetSet(uint256 indexed jobId, uint256 amount);
event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);
event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
event HookFailed(uint256 indexed jobId, bytes4 indexed selector);
```

**Hooks (IACPHook)**

Optional hook contract called after each action with 100,000 gas limit. If it reverts, the parent operation succeeds and `HookFailed` is emitted.

```solidity
interface IACPHook {
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}
```

---

### AgentIdentityRegistry

> `contracts/AgentIdentityRegistry.sol`

ERC-8004 on-chain identity for AI agents.

| Function | Description |
|----------|-------------|
| `register(string agentURI)` | Register agent with JSON metadata URI. Returns `agentId`. Auto-links `msg.sender` as wallet. |
| `setAgentWallet(uint256 agentId, address wallet)` | Link a different wallet to the agent. Agent owner only. |
| `updateURI(uint256 agentId, string newURI)` | Update agent metadata. Agent owner only. |
| `deregister(uint256 agentId)` | Remove agent and free wallet mapping. Agent owner only. |
| `getAgent(uint256 agentId)` | Returns `(uri, owner, wallet)`. |
| `agentOf(address wallet)` | Look up agent ID by wallet address. |
| `pause()` / `unpause()` | Owner only. |

**Events:** `AgentRegistered`, `AgentWalletSet`, `AgentURIUpdated`, `AgentDeregistered`

---

### AgentReputationRegistry

> `contracts/AgentReputationRegistry.sol`

On-chain feedback for AI agents with proof-of-payment validation.

**Constructor**

```solidity
constructor(address _verifier)  // X402PaymentVerifier address
```

| Function | Description |
|----------|-------------|
| `giveFeedback(uint256 agentId, uint8 score, bytes32[] tags, bytes proofOfPayment)` | Submit feedback. `proofOfPayment` must be a valid nonce from X402PaymentVerifier. |
| `getSummary(uint256 agentId)` | Returns `(totalFeedback, averageScore, lastUpdated)`. |
| `getFeedback(uint256 agentId, uint256 index)` | Returns individual feedback entry. |
| `feedbackCount(uint256 agentId)` | Returns total feedback count. |
| `pause()` / `unpause()` | Owner only. |

**Events:** `FeedbackGiven(uint256 indexed agentId, address indexed reviewer, uint8 score)`

---

### MARCTimelock

> `contracts/governance/MARCTimelock.sol`

Governance timelock wrapping OpenZeppelin `TimelockController`. Minimum delay 1 hour, recommended 48 hours.

```solidity
constructor(uint256 minDelay, address[] proposers, address[] executors, address admin)
```

Inherits all `TimelockController` functions: `schedule`, `execute`, `cancel`, `getMinDelay`, etc.

---

## TypeScript SDK

> `sdk/src/`

Install: The SDK is part of the monorepo. Import from `fhe-x402-sdk`.

### fhePaywall(config)

Express middleware that gates a route behind an x402 FHE payment.

```typescript
import { fhePaywall } from "fhe-x402-sdk";

app.get("/api/premium", fhePaywall({
  price: "100000",            // 0.10 USDC (6 decimals)
  asset: "USDC",
  tokenAddress: "0x...",      // ConfidentialUSDC
  verifierAddress: "0x...",   // X402PaymentVerifier
  recipientAddress: "0x...",  // Your server wallet
  rpcUrl: "https://...",
  chainId: 11155111,
}), (req, res) => {
  // req.paymentInfo contains payment details
  res.json({ data: "premium content" });
});
```

**FhePaywallConfig**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `price` | `number \| string` | required | USDC amount in 6-decimal units |
| `asset` | `string` | required | Token symbol (e.g. "USDC") |
| `tokenAddress` | `string` | required | ConfidentialUSDC contract address |
| `verifierAddress` | `string` | required | X402PaymentVerifier contract address |
| `recipientAddress` | `string` | required | Server wallet that receives payment |
| `rpcUrl` | `string` | required | Ethereum RPC endpoint |
| `chainId` | `number` | 11155111 | Chain ID |
| `maxTimeoutSeconds` | `number` | 300 | Payment timeout |
| `maxRateLimit` | `number` | 60 | Max requests per window per IP |
| `rateLimitWindowMs` | `number` | 60000 | Rate limit window |
| `minConfirmations` | `number` | 1 | Required block confirmations |
| `nonceStore` | `NonceStore` | InMemory | External nonce persistence |
| `trustProxy` | `boolean` | false | Trust X-Forwarded-For header |
| `rpcTimeoutMs` | `number` | 30000 | RPC request timeout |
| `onPaymentVerified` | `function` | — | Success callback |
| `onPaymentFailed` | `function` | — | Failure callback |
| `webhookUrl` | `string` | — | Webhook URL for settlement events |
| `webhookSecret` | `string` | — | HMAC-SHA256 secret for webhook |

**Behavior:**
- No `Payment` header -> responds 402 with `FhePaymentRequired` body
- Has `Payment` header -> decodes base64 JSON, verifies ECDSA signature, verifies `ConfidentialTransfer` + `PaymentVerified` events on-chain, attaches `req.paymentInfo`, calls `next()`

---

### fheBatchPaywall(config)

Express middleware with batch prepayment support. Same config as `fhePaywall`.

```typescript
import { fheBatchPaywall } from "fhe-x402-sdk";

app.get("/api/data", fheBatchPaywall({
  price: "50000",  // 0.05 USDC per request
  asset: "USDC",
  tokenAddress: "0x...",
  verifierAddress: "0x...",
  recipientAddress: "0x...",
  rpcUrl: "https://...",
}), (req, res) => {
  res.json({ data: "batch content" });
});
```

**Batch flow:**
1. First request: agent sends batch payment header with `requestCount` + `pricePerRequest`
2. Middleware verifies `BatchPaymentRecorded` event on-chain, registers credits in per-instance store
3. Subsequent requests: agent sends same nonce, middleware deducts one credit (no on-chain verification)
4. When credits exhausted: middleware returns 402

**Response headers:**
- `X-Batch-Credits-Remaining` — remaining credits after this request
- `X-Batch-Credits-Expiry-Warning` — warning when credits expire within 1 hour

---

### FhePaymentHandler

Client-side payment handler for x402 flows.

```typescript
import { FhePaymentHandler } from "fhe-x402-sdk";

const handler = new FhePaymentHandler(signer, fhevmInstance, {
  maxPayment: 10_000_000n,        // 10 USDC max
  allowedNetworks: ["eip155:11155111"],
});
```

**Methods**

| Method | Returns | Description |
|--------|---------|-------------|
| `parsePaymentRequired(response)` | `FhePaymentRequired \| null` | Parse 402 response body |
| `selectRequirement(requirements)` | `FhePaymentRequirements \| null` | Select matching FHE requirement |
| `createPayment(requirements)` | `FhePaymentResult` | 2-TX flow: confidentialTransfer + recordPayment |
| `createSingleTxPayment(requirements)` | `FhePaymentResult` | Single-TX via payAndRecord (local testing only) |
| `createBatchPayment(requirements, requestCount, pricePerRequest)` | `FheBatchPaymentResult` | Batch prepayment: transfer total + recordBatchPayment |
| `handlePaymentRequired(response, options?)` | `FhePaymentResult \| null` | Auto-parse + select + pay |

**FhePaymentResult**

```typescript
interface FhePaymentResult {
  paymentHeader: string;    // base64-encoded payment payload
  txHash: string;           // confidentialTransfer TX hash
  verifierTxHash: string;   // recordPayment TX hash (empty for single-TX)
  nonce: string;            // bytes32 hex
}
```

**FheBatchPaymentResult** — extends FhePaymentResult with `requestCount` and `pricePerRequest`.

---

### createFacilitatorServer(config)

Creates an Express app with x402-standard facilitator endpoints.

```typescript
import { createFacilitatorServer } from "fhe-x402-sdk";

const app = await createFacilitatorServer({
  tokenAddress: "0x...",
  verifierAddress: "0x...",
  rpcUrl: "https://...",
  apiKey: "my-secret-key",  // optional
  chainId: 11155111,
  allowedOrigins: ["https://myapp.com"],
});
app.listen(3001);
```

**FacilitatorConfig**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `tokenAddress` | `string` | required | ConfidentialUSDC address |
| `verifierAddress` | `string` | required | X402PaymentVerifier address |
| `rpcUrl` | `string` | required | RPC endpoint |
| `name` | `string` | "FHE x402 Facilitator" | Server name |
| `version` | `string` | "1.0.0" | Version string |
| `apiKey` | `string` | — | API key for authentication (header: `X-FHE-x402-API-Key`) |
| `chainId` | `number` | 11155111 | Chain ID |
| `allowedOrigins` | `string[]` | [] (allow all) | CORS origins |

**Endpoints**

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /info` | No | Protocol info: schemes, networks, tokens, fee structure |
| `POST /verify` | Yes | Verify payment: checks ConfidentialTransfer event on-chain |
| `GET /health` | No | Health check |

---

### Utility Exports

**Encoding/Decoding**

```typescript
decodePaymentHeader(header: string): FhePaymentPayload
decodeBatchPaymentHeader(header: string): FheBatchPaymentPayload
canonicalPayloadMessage(data: Record<string, unknown>): string
verifyPaymentSignature(payload: FhePaymentPayload | FheBatchPaymentPayload): boolean
```

**Silent Failure Guard**

```typescript
checkSenderHasBalance(provider, tokenAddress, sender): Promise<SilentFailureCheckResult>
checkBalanceChanged(provider, tokenAddress, address, handleBefore): Promise<boolean>
getBalanceBefore(provider, tokenAddress, address): Promise<string>
verifyAfterTransfer(provider, tokenAddress, sender, recipient, handleBefore): Promise<boolean>
```

**Multi-Chain**

```typescript
CHAINS: Record<number, ChainConfig>
getChainConfig(chainId: number): ChainConfig
setChainContracts(chainId: number, contracts: ChainContracts): void
```

**Redis Stores**

```typescript
// Nonce store
new RedisNonceStore(redis, { prefix: "fhe-x402:nonce:", ttlSeconds: 86400 })

// Batch credit store
new RedisBatchCreditStore(redis, { prefix: "fhe-x402:batch:", ttlSeconds: 604800 })
```

**Error Classes**

```typescript
FheX402Error          // Base error
PaymentError          // Payment failed
EncryptionError       // FHE encryption failed
VerificationError     // On-chain verification failed
TimeoutError          // Operation timed out
NetworkError          // Network/RPC error
```

**ERC-8004 Helpers**

```typescript
registerAgent(signer, registryAddress, uri): Promise<TransactionReceipt>
setAgentWallet(signer, registryAddress, agentId, wallet): Promise<TransactionReceipt>
getAgent(provider, registryAddress, agentId): Promise<{uri, owner, wallet}>
agentOf(provider, registryAddress, wallet): Promise<number>
giveFeedback(signer, registryAddress, agentId, score, tags, proof): Promise<TransactionReceipt>
getReputationSummary(provider, registryAddress, agentId): Promise<{totalFeedback, averageScore, lastUpdated}>
```

**ERC-8183 Helpers**

```typescript
createJob(signer, acpAddress, params): Promise<TransactionReceipt>
setBudget(signer, acpAddress, jobId, amount): Promise<TransactionReceipt>
fundJob(signer, acpAddress, jobId, expectedBudget): Promise<TransactionReceipt>
submitDeliverable(signer, acpAddress, jobId, deliverable): Promise<TransactionReceipt>
completeJob(signer, acpAddress, jobId, reason): Promise<TransactionReceipt>
rejectJob(signer, acpAddress, jobId, reason): Promise<TransactionReceipt>
claimRefund(signer, acpAddress, jobId): Promise<TransactionReceipt>
getJob(provider, acpAddress, jobId): Promise<Job>
```

---

## MCP Server

> `packages/mcp-server/`

Model Context Protocol server exposing MARC Protocol tools to AI agents.

**Setup (Claude Desktop)**

```json
{
  "mcpServers": {
    "marc-protocol": {
      "command": "npx",
      "args": ["@marc-protocol/mcp-server"],
      "env": {
        "PRIVATE_KEY": "0x...",
        "CHAIN_ID": "11155111",
        "RPC_URL": "https://..."
      }
    }
  }
}
```

**Environment Variables**

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PRIVATE_KEY` | Yes | — | Wallet private key (hex, 64 chars) |
| `CHAIN_ID` | No | 11155111 | Target chain ID |
| `RPC_URL` | No | Chain default | RPC endpoint override |
| `FHEVM_GATEWAY_URL` | No | https://gateway.zama.ai | Zama FHE Gateway URL |

**Available Tools**

| Tool | Parameters | Description |
|------|------------|-------------|
| `wrap_usdc` | `amount: string` | Wrap USDC into cUSDC. Auto-approves if needed. |
| `unwrap_cusdc` | `amount: string` | Initiate unwrap (step 1 of 2-step async). Requires FHE SDK. |
| `confidential_transfer` | `to: string, amount: string` | Send encrypted cUSDC to an address. Requires FHE SDK. |
| `get_balance` | `address?: string` | Check USDC and cUSDC balances. Defaults to connected wallet. |
| `pay_x402` | `url: string, method?: string` | Full x402 flow: fetch URL, handle 402, encrypt, pay, retry. Requires FHE SDK. |
| `protocol_info` | (none) | Get contract addresses, chain info, fee structure, wallet info. |

**Supported Chains**

| Chain | ID | Status |
|-------|----|--------|
| Ethereum Sepolia | 11155111 | Deployed (v1.0.0) |
| Ethereum Mainnet | 1 | Addresses pending deployment |
