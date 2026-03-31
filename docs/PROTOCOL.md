# FHE x402 Protocol Specification (V4.0)

## Overview

FHE x402 is a token-centric confidential payment protocol for AI agents on Ethereum. It uses Zama's fhEVM to encrypt USDC payment amounts on-chain. Agents wrap USDC into encrypted cUSDC (ERC-7984), transfer it peer-to-peer with hidden amounts, and unwrap back to USDC when needed.

**Scheme identifier:** `fhe-confidential-v1`
**Chain:** Ethereum Sepolia (chainId: 11155111)
**Token:** USDC (6 decimals)

## V4.0 Token-Centric Design

V4.0 replaces the pool-based architecture (V1.0-V3.0) with a token-centric model:

| | V1.0-V3.0 (Pool) | V4.0 (Token-Centric) |
|---|---|---|
| **Balances** | Pool holds all balances | Agents hold cUSDC directly |
| **Deposit** | `pool.deposit(amount)` | `cUSDC.wrap(to, amount)` |
| **Payment** | `pool.pay(to, enc, proof, minPrice, nonce)` | `cUSDC.confidentialTransfer(to, enc, proof)` + `verifier.recordPayment(payer, server, nonce, minPrice)` |
| **Withdraw** | `pool.requestWithdraw()` + `pool.finalizeWithdraw()` | `cUSDC.unwrap(from, to, enc, proof)` + `cUSDC.finalizeUnwrap(handle, cleartext, proof)` |
| **Transfer fee** | Fee on every payment | Free (fee only on wrap/unwrap) |
| **Contracts** | 1 (ConfidentialPaymentPool) | 2 (ConfidentialUSDC + X402PaymentVerifier) |
| **Standard** | Custom | ERC-7984 (OpenZeppelin Confidential Contracts) |

## Contracts

### ConfidentialUSDC

ERC-7984 confidential token that wraps USDC into encrypted cUSDC. Inherits from `ERC7984ERC20Wrapper` for wrap/unwrap mechanics and adds a fee layer on top.

**State:**

| Variable | Type | Description |
|----------|------|-------------|
| `treasury` | `address` | Fee recipient address |
| `accumulatedFees` | `uint256` | Plaintext USDC fees available for withdrawal |
| `_unwrapRecipients` | `mapping(euint64 => address)` | Tracks unwrap request recipients (private) |

**Constants:**

| Constant | Value | Description |
|----------|-------|-------------|
| `FEE_BPS` | 10 | 0.1% fee rate |
| `BPS` | 10,000 | Basis point denominator |
| `MIN_PROTOCOL_FEE` | 10,000 | 0.01 USDC minimum fee |

**Functions:**

#### `wrap(address to, uint256 amount)`
1. Validate `amount > 0`
2. Calculate fee: `max(amount * 10 / 10000, 10000)`
3. Transfer full USDC from sender to contract via `safeTransferFrom`
4. Mint `amount - fee` as encrypted cUSDC to `to`: `_mint(to, FHE.asEuint64(netAmount))`
5. Add fee to `accumulatedFees`
6. Emits: `ConfidentialTransfer(address(0), to, encryptedAmount)`

#### `confidentialTransfer(address to, bytes32 encAmount, bytes inputProof)`
- Inherited from ERC-7984. Transfers encrypted cUSDC peer-to-peer.
- No protocol fee.
- Silent failure: transfers 0 on insufficient balance (no revert, no info leak).
- Emits: `ConfidentialTransfer(from, to, encryptedAmount)`

#### `unwrap(address from, address to, bytes32 encAmount, bytes inputProof)`
1. Verify authorization (`msg.sender == from` or `isOperator(from, msg.sender)`)
2. Burn encrypted tokens from `from`
3. Request KMS decryption of burnt amount
4. Store `_unwrapRecipients[burntAmount] = to`
5. Emits: `UnwrapRequested(to, burntAmount)`

#### `finalizeUnwrap(bytes32 burntAmount, uint64 cleartext, bytes decryptionProof)`
1. Look up recipient from `_unwrapRecipients[burntAmount]`
2. Verify KMS decryption proof via `FHE.checkSignatures`
3. Calculate fee: `max(cleartext * 10 / 10000, 10000)`
4. Transfer `cleartext - fee` USDC to recipient
5. Add fee to `accumulatedFees`
6. Delete `_unwrapRecipients[burntAmount]`
7. Emits: `UnwrapFinalized(to, burntAmount, cleartext)`

### X402PaymentVerifier

Minimal nonce registry for x402 payment verification. Permissionless — any address can record a payment nonce.

**State:**

| Variable | Type | Description |
|----------|------|-------------|
| `usedNonces` | `mapping(bytes32 => bool)` | Replay prevention |

#### `recordPayment(address payer, address server, bytes32 nonce, uint64 minPrice)`
1. Revert if `usedNonces[nonce]` is true
2. Set `usedNonces[nonce] = true`
3. Emit `PaymentVerified(payer, server, nonce, minPrice)`

The `minPrice` parameter allows servers to verify that the payer committed to paying at least the required price, even though the actual encrypted transfer amount is hidden.

## Wire Format

### FhePaymentRequired (402 Response Body)

Sent by the server when no valid `Payment` header is present:

```json
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "fhe-confidential-v1",
    "network": "eip155:11155111",
    "chainId": 11155111,
    "price": "1000000",
    "asset": "USDC",
    "tokenAddress": "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D",
    "verifierAddress": "0x4503A7aee235aBD10e6064BBa8E14235fdF041f4",
    "recipientAddress": "0x...",
    "maxTimeoutSeconds": 300
  }],
  "resource": {
    "url": "https://api.example.com/data",
    "method": "GET"
  }
}
```

### FhePaymentPayload (Payment Header)

Sent by the client as a base64-encoded JSON string in the `Payment` HTTP header:

```json
{
  "scheme": "fhe-confidential-v1",
  "txHash": "0x...",
  "verifierTxHash": "0x...",
  "nonce": "0x...",
  "from": "0x...",
  "chainId": 11155111
}
```

- `txHash` — The `confidentialTransfer` transaction hash
- `verifierTxHash` — The `recordPayment` transaction hash
- `nonce` — Unique bytes32 identifier (generated client-side via `crypto.randomBytes(32)`)

## Payment Flow — Single Payment

```
Agent A                       Chain                          Server B
  |                             |                              |
  |-- GET /api/data ----------------------------------------->|
  |<--- 402 + FhePaymentRequired -----------------------------|
  |                             |                              |
  | fhevmjs.encrypt(amount)    |                              |
  |-- confidentialTransfer --->|                              |
  |  (to, encAmount, proof)    |-- ConfidentialTransfer event |
  |                             |                              |
  |-- recordPayment ---------->|                              |
  |  (payer, server,           |-- PaymentVerified event      |
  |   nonce, minPrice)         |                              |
  |                             |                              |
  |-- Retry + Payment header -------------------------------->|
  |                             |  verify ConfidentialTransfer |
  |                             |  verify PaymentVerified      |
  |                             |  check minPrice >= price     |
  |                             |  check nonce is fresh        |
  |<--- 200 + data -------------------------------------------|
```

## Verification Algorithm

Server-side middleware performs the following checks on each `Payment` header:

1. **Decode** — Base64 decode the `Payment` header, parse as JSON
2. **Scheme** — Verify `scheme === "fhe-confidential-v1"`
3. **Chain** — Verify `chainId` matches expected chain
4. **Nonce freshness** — Check nonce against `NonceStore` (reject replays)
5. **Transfer event** — Fetch receipt for `txHash`, parse `ConfidentialTransfer(from, to, amount)` log:
   - Verify `from` matches payload `from`
   - Verify `to` matches configured `recipientAddress`
   - Verify event emitted from expected `tokenAddress`
6. **Verifier event** — Fetch receipt for `verifierTxHash`, parse `PaymentVerified(payer, server, nonce, minPrice)` log:
   - Verify `payer` matches payload `from`
   - Verify `server` matches configured `recipientAddress`
   - Verify `nonce` matches payload `nonce`
   - Verify `minPrice >= price` (configured required price)
   - Verify event emitted from expected `verifierAddress`
7. **Confirmations** — Check block depth >= `minConfirmations`
8. **Record nonce** — Add nonce to `NonceStore` to prevent replay
9. **Attach info** — Set `req.paymentInfo` and `X-Payment-TxHash` response header
10. **Pass** — Call `next()`

## Fee Model

```
fee = max(amount * FEE_BPS / BPS, MIN_PROTOCOL_FEE)
    = max(amount * 10 / 10000, 10000)
    = max(0.1% of amount, 0.01 USDC)
```

| Amount | Fee | Effective Rate |
|--------|-----|----------------|
| 0.01 USDC | 0.01 USDC | 100% (minimum) |
| 1 USDC | 0.01 USDC | 1% |
| 10 USDC | 0.01 USDC | 0.1% (breakeven) |
| 100 USDC | 0.10 USDC | 0.1% |
| 1,000 USDC | 1.00 USDC | 0.1% |

**Fee is applied on:**
- `wrap()` — Deducted from plaintext USDC before minting cUSDC
- `finalizeUnwrap()` — Deducted from decrypted cleartext before transferring USDC

**Fee is NOT applied on:**
- `confidentialTransfer()` — Free peer-to-peer transfers

**Fee collection:**
- Fees accumulate in `accumulatedFees` (plaintext uint256)
- Treasury or owner calls `treasuryWithdraw()` to collect as USDC

## Silent Failure Pattern

FHE encrypted booleans (`ebool`) cannot be used in Solidity `if` statements. The fhEVM runtime would revert or leak information if code branches on encrypted conditions.

**Implementation:** The ERC-7984 base uses `FHE.select()` to conditionally transfer 0 or the actual amount:

```solidity
euint64 transferAmount = FHE.select(hasSufficientBalance, amount, ZERO);
```

**Implications:**
- `ConfidentialTransfer` events emit on EVERY `confidentialTransfer()` call, even when balance is insufficient
- The server cannot determine whether the actual encrypted transfer was 0 or the full amount
- The server relies on `minPrice` from the `PaymentVerified` event as the payer's commitment
- Bounded risk: one free API response per failed payment (the payer committed minPrice but may have transferred 0)
- No information about actual balance is leaked through success/failure status

## Security Properties

1. **Amount privacy** — Transfer amounts are FHE encrypted. No on-chain observer can see how much was paid.
2. **Balance privacy** — Token balances are FHE encrypted (euint64). Not visible on-chain.
3. **Public participants** — Sender and recipient addresses are visible (deliberate x402 design choice).
4. **Replay prevention** — On-chain `usedNonces` mapping + server-side `NonceStore` with TTL.
5. **Silent failure** — Insufficient balance does not revert, preventing balance inference.
6. **Reentrancy protection** — `nonReentrant` modifier on all state-changing functions.
7. **Access control** — `Ownable2Step` for admin functions, operator system for delegated transfers.
8. **Emergency pause** — Owner can pause wrap/unwrap operations.
9. **Rate limiting** — Per-IP rate limiting using `req.socket.remoteAddress` (not spoofable via headers).
10. **Minimum price commitment** — `recordPayment` requires `minPrice` so servers can verify price commitment even without seeing the encrypted amount.

## Webhook Support

The middleware supports optional webhook notifications for payment events. When configured, the server sends an HTTP POST to the specified URL after successful payment verification.

**Configuration:**

```typescript
{
  webhookUrl: "https://example.com/hooks/payment",
  webhookSecret: "whsec_abc123..."
}
```

**Payload:**

```json
{
  "event": "payment.verified",
  "txHash": "0x...",
  "from": "0x...",
  "nonce": "0x...",
  "minPrice": "1000000",
  "timestamp": 1711800000
}
```

**Signature verification:**

Each webhook request includes an `X-Signature-256` header containing an HMAC-SHA256 signature computed over the raw request body using the `webhookSecret`:

```
X-Signature-256: sha256=<hex-encoded HMAC-SHA256>
```

Recipients should verify this signature before processing the payload to ensure authenticity.

## Batch Credit TTL

When using batch (pre-paid) credits, each credit entry has a configurable time-to-live (TTL). Expired credits are automatically pruned and cannot be used for payment.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `creditTTL` | 7 days (604800s) | How long a batch credit remains valid |

**Configuration:**

```typescript
{
  batchCredits: {
    enabled: true,
    creditTTL: 604800 // 7 days in seconds, configurable via options
  }
}
```

Credits that exceed their TTL are treated as expired and rejected during payment verification. The server returns `402` with a fresh `FhePaymentRequired` response, prompting the client to re-purchase credits.
