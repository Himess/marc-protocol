# FHE x402 Protocol Specification

## Overview

FHE x402 uses Zama's fhEVM to enable encrypted USDC payments between AI agents on Ethereum. Payment amounts are encrypted using Fully Homomorphic Encryption — computations happen directly on ciphertext.

**Scheme identifier:** `fhe-confidential-v1`
**Chain:** Ethereum Sepolia (chainId: 11155111)
**Token:** USDC (6 decimals)

## Contract: ConfidentialPaymentPool

### State

| Variable | Type | Description |
|----------|------|-------------|
| `balances` | `mapping(address => euint64)` | FHE encrypted balances |
| `usedNonces` | `mapping(bytes32 => bool)` | Replay prevention |
| `withdrawPending` | `mapping(address => bool)` | Pending withdrawal flag |
| `isInitialized` | `mapping(address => bool)` | Whether address has deposited |
| `treasury` | `address` | Fee recipient |
| `usdc` | `IERC20` | USDC token contract |

### Functions

#### `deposit(uint64 amount)`
- Transfers plaintext USDC from sender to pool
- Deducts fee: `max(amount * 10 / 10000, MIN_PROTOCOL_FEE)`
- Credits `amount - fee` as encrypted balance: `FHE.add(balance, FHE.asEuint64(netAmount))`
- Sets `isInitialized[sender] = true`
- Emits `Deposited(sender, amount)`
- Requires: `amount >= MIN_PROTOCOL_FEE` (prevents FHE underflow)

#### `pay(address to, bytes32 encryptedAmount, bytes inputProof, uint64 minPrice, bytes32 nonce)`
- Decrypts encrypted amount from fhevmjs input
- Deducts from sender's encrypted balance (silent failure on insufficient funds)
- Credits to recipient's encrypted balance
- Deducts fee from minPrice (plaintext calculation)
- Sends fee to treasury
- Marks nonce as used
- Emits `PaymentExecuted(from, to, minPrice, nonce)`
- Requires: `minPrice >= MIN_PROTOCOL_FEE`, `!usedNonces[nonce]`

#### `requestWithdraw(bytes32 encryptedAmount, bytes inputProof)`
- Initiates async withdrawal (step 1 of 2)
- Deducts encrypted amount from balance
- Sends decryption request to KMS
- Sets `withdrawPending[sender] = true`
- Emits `WithdrawRequested(sender)`

#### `cancelWithdraw()`
- Cancels pending withdrawal, refunds to encrypted balance
- Clears `withdrawPending[sender]`
- Emits `WithdrawCancelled(sender)`

#### `finalizeWithdraw(uint64 clearAmount, bytes decryptionProof)`
- KMS callback with decrypted amount (step 2 of 2)
- Deducts fee from clearAmount
- Transfers plaintext USDC to sender
- Clears `withdrawPending[sender]`
- Emits `WithdrawFinalized(sender, clearAmount)`

#### `requestBalance()`
- Creates snapshot of current encrypted balance
- Sends decryption request to KMS for snapshot (not live balance)

### Fee Structure

```
MIN_PROTOCOL_FEE = 10000  (0.01 USDC)
FEE_BPS = 10              (0.1%)
FEE_DENOMINATOR = 10000

fee = max(amount * FEE_BPS / FEE_DENOMINATOR, MIN_PROTOCOL_FEE)
```

| Payment Amount | Fee | Rate |
|---------------|-----|------|
| 0.01 USDC | 0.01 USDC | 100% (minimum) |
| 1 USDC | 0.01 USDC | 1% (minimum) |
| 10 USDC | 0.01 USDC | 0.1% (breakeven) |
| 100 USDC | 0.10 USDC | 0.1% (percentage) |
| 1000 USDC | 1.00 USDC | 0.1% (percentage) |

### Silent Failure Pattern

FHE encrypted booleans (ebool) cannot be used in Solidity `if` statements. The fhEVM runtime would revert or leak information if code branches on encrypted conditions.

**Solution:** Use `FHE.select()` to conditionally transfer 0 or the actual amount:
```solidity
euint64 transferAmount = FHE.select(hasSufficientBalance, amount, ZERO);
```

**Implications:**
- `PaymentExecuted` event emits on EVERY pay() call, even when balance is insufficient
- Server receives minPrice in the event but cannot determine actual encrypted transfer
- Bounded risk: one free API response per failed payment (minPrice reveals intended cost)
- No information about actual balance is leaked

## x402 Payment Flow

### Client Side

1. `GET /api/premium` → Server returns `402` with `FhePaymentRequired` body
2. Client parses requirements: scheme, network, chainId, price, poolAddress, recipientAddress
3. Client encrypts amount: `fhevmjs.createEncryptedInput(pool, user).add64(amount).encrypt()`
4. Client calls `pool.pay(to, encryptedAmount, inputProof, minPrice, nonce)` on-chain
5. Client waits for confirmation
6. Client retries with `Payment` header: `base64(JSON.stringify({scheme, txHash, nonce, from, chainId}))`

### Server Side (Middleware)

1. Check for `Payment` header
2. If absent → return `402` with requirements
3. If present → decode base64 JSON
4. Verify: scheme matches, chainId matches, nonce is fresh
5. Fetch transaction receipt from RPC
6. Parse logs for `PaymentExecuted` event
7. Verify: from matches, to matches, minPrice >= required price, nonce matches
8. If verified → `next()` with `req.paymentInfo` attached
9. Set `X-Payment-TxHash` response header

### 402 Response Format

```json
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "fhe-confidential-v1",
    "network": "eip155:11155111",
    "chainId": 11155111,
    "price": "1000000",
    "asset": "USDC",
    "poolAddress": "0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73",
    "recipientAddress": "0x...",
    "maxTimeoutSeconds": 300
  }],
  "resource": {
    "url": "https://api.example.com/data",
    "method": "GET"
  }
}
```

### Payment Header Format

```json
{
  "scheme": "fhe-confidential-v1",
  "txHash": "0x...",
  "nonce": "0x...",
  "from": "0x...",
  "chainId": 11155111
}
```

## Security Considerations

1. **Nonce replay prevention** — Each nonce is marked used after first verification
2. **Chain ID validation** — Prevents cross-chain replay attacks
3. **Minimum fee enforcement** — `minPrice >= MIN_PROTOCOL_FEE` prevents FHE underflow
4. **Rate limiting** — IP-based using `socket.remoteAddress` (prevents X-Forwarded-For spoofing)
5. **Payment header size limit** — 100KB max to prevent DoS
6. **Confirmation depth** — Configurable `minConfirmations` for block finality
7. **2-step ownership transfer** — Prevents accidental ownership loss
8. **Balance snapshot** — `requestBalance()` returns snapshot, not live handle (prevents manipulation)
