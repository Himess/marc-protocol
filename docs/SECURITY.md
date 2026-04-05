# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| v1.0.0  | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT open a public GitHub issue**
2. Email details to the maintainer via GitHub profile contact
3. Include: description, reproduction steps, severity assessment, and any suggested fix
4. Allow 72 hours for initial response

## Threat Model

### What FHE x402 Protects

- **Transfer amounts**: Encrypted via FHE (euint64). When agents transfer cUSDC peer-to-peer, the amount is fully encrypted on-chain. No observer can determine how much was transferred.
- **Token balances**: Encrypted via FHE. Individual cUSDC balances are stored as euint64 and are not visible on-chain. Only the balance holder can decrypt via KMS.

### What FHE x402 Does NOT Protect

- **Participant identity**: Sender and recipient addresses are public (x402 requirement). Anyone can see who transacted with whom.
- **Wrap amounts**: Plaintext USDC enters the encrypted domain visibly. The amount wrapped is public on-chain.
- **Unwrap amounts**: Plaintext USDC exits the encrypted domain visibly. The amount unwrapped is public on-chain.
- **Transaction existence**: Events are emitted for all operations (wrap, transfer, unwrap, recordPayment). An observer can see that a transaction occurred, but not the encrypted transfer amount.
- **minPrice commitment**: The `minPrice` parameter in `recordPayment` is plaintext. It reveals the minimum price the server requires, but not the actual amount transferred (which may be higher).

## Security Measures

### Contract-Level (ConfidentialUSDC + X402PaymentVerifier)

- **Reentrancy protection**: `nonReentrant` modifier on all state-changing functions (wrap, unwrap, finalizeUnwrap, confidentialTransfer, treasuryWithdraw)
- **2-step ownership transfer**: `Ownable2Step` — `transferOwnership()` + `acceptOwnership()` prevents accidental lock-out
- **Pausable**: Owner can pause wrap/unwrap in emergencies via `pause()` / `unpause()`
- **Nonce replay prevention**: On-chain `usedNonces` mapping in X402PaymentVerifier prevents double-spending of payment nonces
- **Treasury zero-address check**: Constructor reverts if treasury address is `address(0)`
- **CEI pattern**: Check-Effects-Interactions ordering in all state-changing functions (state reset BEFORE external calls)
- **FHE ACL**: Proper `FHE.allowTransient()` and `FHE.allow()` calls for encrypted value access control

### Additional Measures

- **No `assert()` statements**: All state validation uses `if/revert` with custom errors (assert consumes all gas on failure, revert does not)
- **`_unwrapRecipients` cleanup**: `delete _unwrapRecipients[burntAmount]` called in `finalizeUnwrap` to prevent storage bloat
- **`minPrice` parameter on `recordPayment`**: Servers can verify the committed minimum price, preventing free-rider attacks where an agent sends a negligible amount but claims API access
- **2-step async unwrap with KMS proof verification**: `unwrap()` initiates a request, `finalizeUnwrap()` requires a KMS-signed decryption proof. No single-step plaintext extraction.

### SDK-Level

- **Rate limiting**: Per-IP rate limiting via `req.socket.remoteAddress` (resistant to X-Forwarded-For spoofing)
- **Chain ID verification**: Middleware rejects payments from wrong chain ID
- **Payload size limit**: Payment header capped at 100KB to prevent memory exhaustion
- **NonceStore with TTL**: SDK-level nonce tracking with configurable TTL (24h default) and max entries (100K)
- **API key authentication**: Facilitator server uses timing-safe comparison (`crypto.timingSafeEqual`) for API key verification
- **Minimum confirmations**: Configurable `minConfirmations` for block confirmation depth before accepting payment

## Single-TX Payment Security

### `payAndRecord()` — Single-TX Payment

- **Atomicity**: Combines `confidentialTransfer()` + `recordPayment()` into a single transaction. Either both succeed or both revert. Eliminates the risk of orphaned transfers (transfer succeeds but nonce recording fails).
- **`confidentialTransferAndCall()`**: Calls `onConfidentialTransferReceived()` on the recipient contract. The callback executes in the same transaction, so the recipient can perform verification logic atomically.
- **Reentrancy risk**: The `onConfidentialTransferReceived()` callback introduces a reentrancy vector. Mitigated by `nonReentrant` on the transfer function — the callback cannot re-enter `confidentialTransfer` or `payAndRecord`.

### `confidentialTransferAndCall()` Callback

- The recipient contract must implement `onConfidentialTransferReceived(address from, bytes32 amount, bytes data) returns (bytes4)`. Returning an incorrect selector causes the transfer to revert.
- Arbitrary external calls from the callback are constrained by the `nonReentrant` guard on the calling function.

## Batch Prepayment Security

### `recordBatchPayment()` — Batch Prepayment

- **Batch credits**: A single on-chain transaction records N prepaid request credits. The server tracks remaining credits off-chain.
- **Off-chain credit tracking risk**: The server's in-memory (or Redis) credit counter is the source of truth for remaining requests. If the server restarts without persistence, credits may be lost or double-counted. Use a persistent store (Redis with AOF) in production.
- **Batch size limit**: `recordBatchPayment` enforces a maximum batch size to prevent gas limit issues and excessive storage writes.
- **Price-per-request verification**: The `pricePerRequest` parameter is plaintext and recorded on-chain, allowing third-party auditing of batch pricing.

## Known Limitations

### 1. Silent Failure Event Emission

`ConfidentialTransfer` fires even when the actual transferred amount is 0 (due to insufficient balance). This is inherent to the FHE silent failure pattern — the contract cannot branch on encrypted comparison results. Servers bear bounded risk of one free API response per failed payment, mitigated by `minPrice` verification in the nonce registry.

### 2. In-Memory Nonce and Rate-Limit Stores

The default SDK stores (InMemoryNonceStore, in-memory rate limiter) reset on server restart. **Use Redis or another persistent store in production.** See `examples/redis-nonce-store.ts` for a reference implementation.

### 3. Mock KMS in Tests

`finalizeUnwrap` uses mock decryption proofs in the Hardhat test environment. Production deployments require real Zama KMS infrastructure for the 2-step async unwrap flow.

### 4. FHE Gas Costs

FHE operations (euint64 add, sub, select, compare) are gas-expensive on Ethereum L1. A single `confidentialTransfer` costs approximately $2-5 at current gas prices. Batch prepayment amortizes the per-request cost, and L2 deployment will reduce costs further.

### 5. fhevmjs WASM Dependency

Browser-based clients must load the fhevmjs WASM module (~2MB) for FHE encryption. This adds latency to the first payment. Server-side (Node.js) agents load WASM once at startup and are unaffected.

### 6. Encrypted Amount Verification Gap

Servers cannot verify the exact encrypted amount transferred — they can only verify that a `ConfidentialTransfer` event was emitted and that the `minPrice` in the nonce registry meets their required price. An agent could transfer more than `minPrice` (overpayment), and the server would have no way to detect this. This is by design — amount privacy means the server cannot inspect the actual value.

### 7. Dual-TX Non-Atomicity (Legacy)

In the original dual-TX flow, `confidentialTransfer` and `recordPayment` are separate transactions. If the first succeeds and the second fails, funds are transferred but the nonce is not recorded. **This is resolved** with the atomic `payAndRecord()` function.

## Audit History

### Internal Audit (2026-03-10)

Full audit report: [docs/archived/AUDIT-V4.0.md](archived/AUDIT-V4.0.md)

4 findings fixed:

| Severity | Finding | Fix |
|----------|---------|-----|
| CRITICAL | `minPrice` parameter missing from `recordPayment` — servers could not verify committed price | Added `minPrice` parameter to `recordPayment(payer, server, nonce, minPrice)` |
| HIGH | `assert()` used for state validation in ConfidentialUSDC — consumes all gas on failure | Replaced with `if/revert` and custom errors |
| MEDIUM | `_unwrapRecipients` mapping not cleaned up after `finalizeUnwrap` — storage bloat | Added `delete _unwrapRecipients[burntAmount]` in `finalizeUnwrap` |
| LOW | `POOL_CAP_EXCEEDED` dead error code in SDK errors.ts — leftover from legacy architecture | Removed dead error code |

### Overall Security Score: 8.5/10

**Strong:**
- Reentrancy protection on all state-changing functions
- CEI pattern consistently followed
- 2-step ownership transfer
- Nonce replay prevention (on-chain + SDK-level)
- IP-based rate limiting resistant to header spoofing
- API key timing-safe comparison
- FHE ACL properly applied
- No `assert()` statements (all `if/revert`)

**Remaining risk:**
- Silent failure is inherent to FHE (mitigated by minPrice, bounded to 1 free response)
- FHE gas costs limit L1 viability for high-frequency payments (mitigated by batch prepayment)
- Mock KMS in tests (production requires real Zama KMS)

## Bug Bounty

No formal bug bounty program at this time. Significant findings will be credited in the CHANGELOG. A formal program will be established before mainnet deployment.
