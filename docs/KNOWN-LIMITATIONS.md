# MARC Protocol — Known Limitations & Design Decisions

This document describes inherent limitations of the MARC Protocol that cannot be
"fixed" without fundamental protocol changes. These are documented for transparency
and to help integrators make informed decisions.

---

## 1. FHE Silent Failure (Fundamental)

**What:** When `confidentialTransfer()` is called with an encrypted amount exceeding
the sender's encrypted balance, the FHE VM cannot revert (that would leak balance
information). Instead, it transfers **0 tokens** silently. The transaction succeeds,
events are emitted, but no funds actually move.

**Impact:** A server accepting x402 payments may deliver service for a 0-amount
payment. Each failed payment costs the server one API response.

**Mitigation:**
- `silentFailureGuard.ts` provides a heuristic (pre/post balance handle comparison)
- `X402PaymentVerifier.recordPayment(minPrice)` records the expected amount on-chain
- Batch prepayment reduces per-request exposure
- `AgentReputationRegistry` tracks malicious agents

**Why not fixable:** This is inherent to FHE — encrypted conditionals cannot branch.
Zama's `FHE.select()` evaluates both branches and selects based on the encrypted
condition, making success/failure indistinguishable by design.

**Future:** KMS-based amount decryption (post-transfer, authorized verification)
could provide cryptographic proof of transferred amount. This requires Zama's
decryption gateway and adds latency.

---

## 2. Batch Credit Replay via Captured Payment Header

**What:** Batch payments use a static `Payment` header for N requests. If an attacker
captures this header (network interception, log access, etc.), they can consume the
remaining batch credits by replaying the exact same header.

**Impact:** An attacker with access to a valid batch Payment header can steal the
remaining prepaid credits.

**Why not fixable (without protocol change):** The batch model is "pay once, reuse
N times" — the header MUST be static for the subsequent N-1 requests. Adding a
per-request nonce would defeat the purpose of batching (each request would need a
new on-chain transaction).

**Mitigation:**
- Use HTTPS exclusively (prevents network interception)
- Do not log Payment headers in server access logs
- Use short batch sizes (10-50 instead of 10,000)
- Combine with API key authentication for additional binding
- Consider time-limited batch sessions (TTL on credits)

---

## 3. In-Memory Nonce Store Is Per-Process

**What:** The default `InMemoryNonceStore` stores nonces in a JavaScript `Map`.
On server restart, all nonces are lost. In multi-instance deployments (load balancer
with N servers), each instance has its own nonce store.

**Impact:**
- Server restart: all previously-used nonces can be replayed
- Multi-instance: a nonce accepted by Server A is unknown to Server B

**Mitigation:**
- **Production MUST use `RedisNonceStore`** (atomic SET NX EX, shared across instances)
- The SDK logs a warning when using in-memory store in non-test environments
- On-chain `usedNonces` mapping provides a permanent record (middleware could query
  this as a fallback, but adds RPC latency per request)

---

## 4. 2-TX Flow: TX1 Success + TX2 Failure

**What:** The V4.0 payment flow uses two transactions:
1. `confidentialTransfer()` — moves encrypted cUSDC to recipient
2. `recordPayment()` — records nonce on-chain for server verification

If TX1 succeeds but TX2 fails (gas issue, network error, nonce collision), the
funds are transferred but no on-chain payment record exists.

**Impact:** The server will never accept a Payment header for this transfer because
the `PaymentVerified` event was never emitted. The funds are in the recipient's
wallet but the client received no service.

**Mitigation:**
- Error includes `transferTxHash` and `recoverable: true` so the client can
  contact the service provider for manual resolution
- The client can retry TX2 with the same nonce (idempotent if TX2 originally
  failed before on-chain execution)
- V4.2 `payAndRecord()` provides a single-TX atomic flow, but has FHE proof
  binding limitations with real fhEVM (works in test/mock environments)

**Future:** When Zama resolves FHE proof delegation (allowing a contract to act
on behalf of the original encryptor), the single-TX flow will work on mainnet.

---

## 5. Deploy Ownership Transfer Window (Ownable2Step)

**What:** The mainnet deploy script transfers ownership to the Timelock using
`transferOwnership()`, which sets `pendingOwner`. The Timelock must then call
`acceptOwnership()` to finalize. This requires the Safe (as proposer/executor on
the Timelock) to schedule and execute this operation, with a 48-hour delay.

**Impact:** Between deployment and ownership acceptance (potentially 48+ hours),
the deployer EOA retains full owner privileges (pause, setTreasury, etc.).

**Mitigation:**
- Deploy from a hardware wallet (Ledger/Trezor)
- Schedule `acceptOwnership()` immediately after deployment
- Monitor the contract for any owner actions during the window
- The deployer should have minimal ETH (just enough for gas)
- Post-deploy verification script checks `pendingOwner` is set correctly

---

## 6. Encrypted Amount Verification (Server-Side)

**What:** When a server receives a payment, it can verify that a `ConfidentialTransfer`
event was emitted with the correct `from` and `to` addresses, but it CANNOT verify
the encrypted amount matches the required price.

**Impact:** The `minPrice` parameter in `recordPayment()` provides a cleartext
commitment from the payer about the minimum amount, but this is self-reported
(the payer chooses what to declare). The actual encrypted transfer amount may
differ from `minPrice`.

**Mitigation:**
- `minPrice` creates an on-chain record that can be used for dispute resolution
- Silent failure guard provides a heuristic balance check
- Reputation system tracks agents with suspicious payment patterns
- Batch prepayment with verified `totalAmount` provides per-batch guarantees

---

## 7. X-Forwarded-For Trust

**What:** The paywall middleware and facilitator read `X-Forwarded-For` headers
for rate limiting when behind a reverse proxy.

**Impact:** If the application is NOT behind a trusted reverse proxy, an attacker
can spoof the header to bypass rate limits.

**Mitigation:**
- Deploy behind a trusted reverse proxy (nginx, Cloudflare, AWS ALB) that
  overwrites the `X-Forwarded-For` header with the real client IP
- For direct-exposure deployments, the middleware falls back to `req.socket.remoteAddress`
- Rate limiting is defense-in-depth, not a security boundary

---

## Summary

| Limitation | Category | Severity | Fixable? |
|-----------|----------|----------|----------|
| FHE silent failure | Cryptographic | HIGH | No (FHE fundamental) |
| Batch credit replay | Protocol design | MEDIUM | Only with per-request nonces (breaks batching) |
| In-memory nonce store | Infrastructure | MEDIUM | Use Redis in production |
| 2-TX flow failure | Protocol design | MEDIUM | Single-TX when FHE proof delegation available |
| Ownership transfer window | Governance | LOW | Minimize window, use hardware wallet |
| Encrypted amount verification | Cryptographic | LOW | KMS decryption (future) |
| X-Forwarded-For trust | Infrastructure | LOW | Deploy behind trusted proxy |
