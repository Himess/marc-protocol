# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| V1.1    | Yes       |
| < V1.0  | No        |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT open a public GitHub issue**
2. Email details to the maintainer via GitHub profile contact
3. Include: description, reproduction steps, severity assessment, and any suggested fix
4. Allow 72 hours for initial response

## Threat Model

### What FHE x402 Protects

- **Payment amounts**: Encrypted via FHE (euint64). No on-chain observer can determine how much was paid.
- **Pool balances**: Encrypted via FHE. Individual balances are not visible on-chain.

### What FHE x402 Does NOT Protect

- **Participant identity**: Sender and recipient addresses are public (x402 requirement).
- **Transaction existence**: Events are emitted for all operations (deposit, pay, withdraw).
- **Deposit amounts**: Plaintext USDC is transferred into the pool (visible on-chain).

### Known Limitations

1. **Silent failure event emission**: `PaymentExecuted` emits even on 0-transfer (inherent to FHE). Servers bear bounded risk of one free API response per failed payment.
2. **In-memory nonce/rate-limit stores**: Reset on server restart. Use external stores (Redis) in production.
3. **Mock KMS in tests**: `finalizeWithdraw` uses mock proofs in tests. Production requires real Zama KMS.
4. **FHE gas costs**: FHE operations (add, sub, select, compare) are gas-expensive on Ethereum L1.

### Security Measures

- **Reentrancy protection**: `nonReentrant` on deposit, pay, requestWithdraw, finalizeWithdraw
- **2-step ownership transfer**: transferOwnership + acceptOwnership (prevents accidental lock-out)
- **Nonce replay prevention**: On-chain `usedNonces` mapping + SDK-level NonceStore with TTL
- **Rate limiting**: Per-IP with `req.socket.remoteAddress` (prevents X-Forwarded-For spoofing)
- **Minimum fee enforcement**: `minPrice >= MIN_PROTOCOL_FEE` prevents FHE underflow
- **Treasury exclusion**: Treasury address cannot be payment recipient
- **Balance snapshot**: `requestBalance()` creates snapshot (does not expose live handle)
- **Chain ID verification**: Middleware rejects payments from wrong chain
- **Payload size limit**: Payment header capped at 100KB

## Audit History

### V1.1 Audit (Internal)

11 findings fixed:
- C-1: Price comparison corrected (`>=` not `<=`)
- C-2: `minPrice >= MIN_PROTOCOL_FEE` enforced
- C-3: `amount >= MIN_PROTOCOL_FEE` enforced in deposit
- H-1: `cancelWithdraw()` added
- H-2: `requestBalance()` creates snapshot
- H-3: 2-step ownership transfer
- H-4: `NonceStore` interface with TTL
- H-5: Chain ID verification in middleware
- M-2: Configurable `minConfirmations`
- M-4: `minPrice >= MIN_PROTOCOL_FEE` validation
- M-5: Treasury cannot be payment recipient

## Bug Bounty

No formal bug bounty program at this time. Significant findings will be credited in the CHANGELOG.
