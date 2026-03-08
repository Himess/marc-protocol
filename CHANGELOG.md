# Changelog

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
- SDK test count: 52 → 72 (facilitator + ERC-8004 tests added)
- Total tests: 138 → 211
- Real fhevmjs integration in all files (no mock/placeholder code)
- NonceStore interface now supports atomic `checkAndAdd()` method
- InMemoryNonceStore now has TTL-based nonce expiry (24h default)
- Frontend forms now validate inputs and show loading states
- POOL_ABI uses `bytes32` for encrypted parameters (ethers.js compatible)

### Fixed
- `requestWithdraw()` now has `nonReentrant` modifier
- `decodePaymentHeader()` validates required fields before returning
- Frontend POOL_ABI used `externalEuint64` (not valid for ethers.js ABI encoding) → fixed to `bytes32`
- Frontend `_getConnection()` private API usage → replaced with direct RPC URL
- License headers: MIT → BUSL-1.1 (contracts, package.json)
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
- Silent failure pattern (insufficient balance → 0 transfer, no revert)
- Protocol fee: max(0.1%, $0.01 minimum) on deposit, pay, withdraw
- 2-step async withdrawal via Zama KMS
- TypeScript SDK: FhePaymentHandler, fhePaywallMiddleware, fheFetch
- 138 tests (86 contract + 52 SDK)
- Deployed and verified on Ethereum Sepolia
- CI/CD pipeline (GitHub Actions)
