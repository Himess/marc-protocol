# Changelog

## V4.3 — Batch Prepayment + Deep Audit (March 2026)

### Added
- **Batch prepayment** — `recordBatchPayment()` on X402PaymentVerifier for prepaid request bundles
- **`fheBatchPaywall()` middleware** — server-side batch credit tracking with per-instance isolation
- **`createBatchPayment()` on FhePaymentHandler** — client-side batch prepayment flow
- **`FheBatchPaymentPayload` type** — extends payment payload with `requestCount` + `pricePerRequest`
- **`decodeBatchPaymentHeader()`** — decode base64 batch payment headers
- **`RedisBatchCreditStore`** — production Redis-backed batch credit persistence with atomic DECR
- **`BatchCreditStore` interface** — pluggable batch credit storage (Redis, DB, memory)
- **`X-Batch-Credits-Remaining` header** — returned by batch middleware after each request
- **`X-Batch-Credits-Expiry-Warning` header** — warns when credits expire within 1 hour
- **`BatchPaymentRecorded` event** — emitted by verifier for batch nonce registration
- **`NonceCancelled` event + `cancelNonce()`** — allows payer to cancel unused nonces
- **`nonceOwners` mapping** — tracks who recorded each nonce for cancellation
- **AgentReputationRegistry** — on-chain feedback with proof-of-payment via X402PaymentVerifier nonce validation
- **AgentIdentityRegistry** — ERC-8004 on-chain identity for AI agents with wallet linking
- **AgenticCommerceProtocol (ACP)** — ERC-8183 job escrow with lifecycle hooks (IACPHook)
- **MARCTimelock** — governance timelock (48h minimum) wrapping OpenZeppelin TimelockController
- **Mainnet deploy script** (`02_deploy_mainnet.ts`) — 6-contract deploy + ownership transfer + Etherscan verification
- **MCP Server** (`@marc-protocol/mcp-server`) — 6 tools: wrap_usdc, unwrap_cusdc, confidential_transfer, get_balance, pay_x402, protocol_info
- **Subgraph** — The Graph indexing for ConfidentialTransfer, PaymentVerified, BatchPaymentRecorded events
- **Frontend** — React demo app deployed to Vercel
- **Virtuals GAME agent demo** — real API key integration, self-contained (no SDK build needed)
- **ERC-8183 SDK helpers** — `connectACP`, `createJob`, `fundJob`, `submitDeliverable`, `completeJob`, `rejectJob`, `claimRefund`
- **ERC-8004 SDK helpers** — `registerAgent`, `setAgentWallet`, `getAgent`, `agentOf`, `giveFeedback`, `getReputationSummary`
- **Silent failure guard** — `checkSenderHasBalance()`, `checkBalanceChanged()`, `getBalanceBefore()`, `verifyAfterTransfer()`
- **Multi-chain config** — `CHAINS`, `getChainConfig()`, `setChainContracts()` with Sepolia + Mainnet
- **Webhook support** — `webhookUrl` + `webhookSecret` (HMAC-SHA256) in FhePaywallConfig
- **Payment callbacks** — `onPaymentVerified` + `onPaymentFailed` in middleware config
- **800+ tests** across contracts, SDK, integration, and on-chain FHE tests

### Changed
- Contracts rewritten from ConfidentialPaymentPool to token-centric ConfidentialUSDC (ERC-7984 + ERC7984ERC20Wrapper)
- X402PaymentVerifier redesigned as thin nonce registry (no pool dependency)
- ACP constructor validates paymentToken is a deployed contract (not EOA)
- Nonce format validation: must be `0x` + 64 hex chars
- ECDSA signature verification on all payment headers (prevents forgery)
- Rate limiter is per-instance (prevents cross-route interference)
- Nonce mutex via `pendingNonces` Set prevents concurrent processing of same nonce
- SDK exports reorganized: ERC-8004, ERC-8183, Redis stores, silent failure guard, chains, errors
- Facilitator version bumped to 4.3.0

### Fixed
- **M-1**: Rate conversion assertion — `rate() != 1` check in ConfidentialUSDC constructor
- **M-2**: Self-transfer prevention — `confidentialTransferAndCall()` reverts on `to == msg.sender`
- **M-3**: ACP evaluator-provider separation — `SelfDealing` error when evaluator == provider
- **L-1**: USDC decimal validation — constructor checks `decimals() == 6`
- **L-3**: WalletAlreadyLinked — prevents same wallet being linked to multiple agents
- **L-5**: ACP paymentToken contract check — rejects EOA addresses
- Batch overflow check: `requestCount * pricePerRequest` must fit uint64
- README inconsistencies: test counts, deprecated fhevmjs references, Solidity version
- Frontend build errors for Vercel deployment
- CI/CD: prettier formatting, hardhat-plugin version patch, --legacy-peer-deps for peer conflicts

### Security
- Nonce cancellation restricted to original recorder (`nonceOwners` mapping)
- Batch credit stores are per-instance (prevents cross-route credit consumption attacks)
- Batch credit TTL: 7 days (auto-expiry prevents stale credit accumulation)
- ERC-1363 fee bypass prevention — `onTransferReceived()` reverts with "use wrap()"
- All transfer paths blocked during pause (wrap, unwrap, confidentialTransfer, setOperator)
- Hook callbacks capped at 100,000 gas with try/catch (prevents hook griefing)
- Ownership uses Ownable2Step (requires explicit `acceptOwnership()`)
- Timelock: 48h delay, admin renounced, Gnosis Safe as sole proposer/executor

## V4.2 — Single-TX Payment + TransferAndCall (March 2026)

### Added
- **`payAndRecord()`** on X402PaymentVerifier — combined transfer + nonce recording in one TX
- **`confidentialTransferAndCall()`** on ConfidentialUSDC — ERC-7984 transfer + callback pattern
- **`onConfidentialTransferReceived()`** on X402PaymentVerifier — IERC7984Receiver callback
- **`PayAndRecordCompleted` event** — emitted for single-TX payments
- **`createSingleTxPayment()` on FhePaymentHandler** — SDK support for single-TX flow
- **Operator approval flow** — agent sets verifier as ERC-7984 operator via `setOperator()`
- **Middleware single-TX path** — detects empty `verifierTxHash` and verifies PayAndRecordCompleted event
- **`createAndFund()` on ACP** — create + fund a job in one transaction
- **`fund()` expectedBudget param** — prevents front-running budget changes

### Changed
- Payment handler `handlePaymentRequired()` accepts `preferSingleTx` option
- Middleware verifies both dual-TX (PaymentVerified) and single-TX (PayAndRecordCompleted) event paths

### Security
- FHE input proof binding: single-TX `payAndRecord()` noted as incompatible with real FHE on Sepolia/mainnet (proofs bound to msg.sender)
- `confidentialTransferAndCall` has `nonReentrant` + `whenNotPaused` guards

## V4.0 — Token-Centric Rewrite (March 2026)

### Added
- **ConfidentialUSDC** — ERC-7984 + ERC7984ERC20Wrapper token. Wrap USDC to encrypted cUSDC, transfer privately, unwrap back
- **X402PaymentVerifier** — thin on-chain nonce registry with `recordPayment()` + `usedNonces()` mapping
- **Fee-free transfers** — agent-to-agent cUSDC transfers have no protocol fee (fees only on wrap/unwrap)
- **2-step async unwrap** — `_unwrap()` submits to Zama KMS, `finalizeUnwrap()` completes after decryption
- **Dust protection** — wrap amount must exceed `MIN_PROTOCOL_FEE` so net amount > 0
- **EIP-191 signed payment headers** — `canonicalPayloadMessage()` + `verifyPaymentSignature()`
- **Silent failure heuristic** — middleware checks sender's encrypted balance handle is non-zero
- **Confirmation depth check** — `minConfirmations` config option for block confirmation requirements
- **`FhePaymentRequired` response** — structured 402 body with `x402Version`, `accepts[]`, `resource`

### Changed
- Complete architecture rewrite: pool-based → token-centric
- Agents hold cUSDC directly instead of depositing into a shared pool
- Protocol fee: max(0.1%, $0.01 minimum) charged on wrap and unwrap only
- SDK FhePaymentHandler rewritten for 2-TX flow: confidentialTransfer + recordPayment
- Payment payload includes `verifierTxHash` field (separate TX for nonce recording)

### Removed
- ConfidentialPaymentPool contract (replaced by ConfidentialUSDC)
- Pool-based deposit/withdraw flow
- UUPS proxy pattern (removed in favor of simpler Ownable2Step + Timelock)
- Decryption gateway (replaced by Zama KMS standard flow)

## V2.0 + V2.1 — FHE Operations + Spending Limits (March 2026)

### Added
- **33 FHE operation combinations** — add, sub, mul, div, rem, min, max, eq, ne, gt, gte, lt, lte, and, or, xor, not, shl, shr, neg, select across encrypted types
- **5 encrypted types** — ebool, euint4, euint8, euint16, euint64
- **Spending limit** — per-address spending caps with configurable period
- **Fee rounding** — proper rounding for small amounts to avoid zero-fee transfers

### Changed
- Extended FHE operation test coverage (33 combinations)
- Fee calculation uses uint256 intermediate to prevent overflow

## V1.3 — Proxy + Infrastructure (March 2026)

### Added
- **UUPS proxy** — upgradeable contract deployment pattern
- **Decryption gateway** — async decryption via Zama KMS callback
- **Subgraph** — The Graph indexing for pool events
- **RedisNonceStore** — persistent nonce tracking for multi-instance deployments

### Changed
- Contract deployed behind UUPS proxy for upgradeability

## V1.2 — Hardening (March 2026)

### Added
- **Pausable** — emergency pause on all operations
- **Treasury withdraw** — owner can withdraw accumulated protocol fees
- **Timeout** — payment expiry via `maxTimeoutSeconds`
- **Caps** — maximum payment/deposit limits
- **Memo field** — optional payment metadata
- **SDK error classes** — `FheX402Error`, `PaymentError`, `EncryptionError`, `VerificationError`, `TimeoutError`, `NetworkError`
- **ElizaOS plugin** — 3 actions (FHE_PAY, FHE_BALANCE, FHE_DEPOSIT)
- **Virtuals GAME plugin** — 5 GameFunctions (deposit, pay, withdraw, balance, info)
- **OpenClaw skill** — 6 CLI scripts

### Changed
- NonceStore interface supports atomic `checkAndAdd()` method
- InMemoryNonceStore has TTL-based nonce expiry (24h default)

## V1.1 — Agent Ecosystem (March 2026)

### Added
- **Facilitator server** — x402-standard endpoints (/info, /verify, /health) with API key auth
- **ERC-8004 integration** — `fhePaymentMethod()` and `fhePaymentProof()` helpers
- **Virtuals GAME plugin** — 5 GameFunctions (deposit, pay, withdraw, balance, info) — 28 tests
- **OpenClaw skill** — 6 CLI scripts (balance, deposit, pay, withdraw, info, shared wallet) — 25 tests
- **ElizaOS example plugin** — 3 actions (FHE_PAY, FHE_BALANCE, FHE_DEPOSIT)
- **React frontend demo** — Connect, deposit, pay, balance, withdraw with real fhevmjs
- **Demo scripts** — Terminal demo, buyer/seller examples with real FHE encryption
- **Documentation** — LIGHTPAPER.md, PROTOCOL.md, ROADMAP.md, TODO.md, SECURITY.md

### Changed
- SDK test count: 52 to 72 (facilitator + ERC-8004 tests added)
- Total tests: 138 to 211
- Real fhevmjs integration in all files (no mock/placeholder code)
- NonceStore interface now supports atomic `checkAndAdd()` method
- InMemoryNonceStore now has TTL-based nonce expiry (24h default)
- Frontend forms now validate inputs and show loading states
- POOL_ABI uses `bytes32` for encrypted parameters (ethers.js compatible)

### Fixed
- `requestWithdraw()` now has `nonReentrant` modifier
- `decodePaymentHeader()` validates required fields before returning
- Frontend POOL_ABI used `externalEuint64` (not valid for ethers.js ABI encoding) — fixed to `bytes32`
- Frontend `_getConnection()` private API usage — replaced with direct RPC URL
- License headers: MIT to BUSL-1.1 (contracts, package.json)
- Rate limiter cleanup on capacity threshold
- Nonce race condition: atomic check-and-add when supported

### Security
- Added SECURITY.md with threat model and responsible disclosure policy
- Chain ID verification in middleware (rejects wrong-chain payments)
- Payload size limit on Payment header (100KB)
- Per-IP rate limiting via socket address (prevents X-Forwarded-For spoofing)

## V1.0 — Core Protocol (March 2026)

### Added
- ConfidentialPaymentPool contract with FHE encrypted balances (euint64)
- Silent failure pattern (insufficient balance results in 0 transfer, no revert)
- Protocol fee: max(0.1%, $0.01 minimum) on deposit, pay, withdraw
- 2-step async withdrawal via Zama KMS
- TypeScript SDK: FhePaymentHandler, fhePaywallMiddleware, fheFetch
- 138 tests (86 contract + 52 SDK)
- Deployed and verified on Ethereum Sepolia
- CI/CD pipeline (GitHub Actions)
