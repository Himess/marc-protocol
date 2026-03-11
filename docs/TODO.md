# FHE x402 — Development Tracker

## Completed (V1.0)

- [x] ConfidentialPaymentPool contract (deposit, pay, withdraw, fees, silent failure)
- [x] Contract interfaces and MockUSDC
- [x] 86 contract tests (deposit, pay, withdraw, fee, edge cases, e2e)
- [x] TypeScript SDK: FhePaymentHandler, fhePaywall middleware, fheFetch
- [x] 52 SDK tests (handler, middleware, fetch)
- [x] Hardhat deploy script
- [x] Sepolia deployment (contracts verified on Etherscan)
- [x] CI/CD pipeline (build + test for contracts and SDK)
- [x] Security audit V1.1 (11 findings fixed)

## Completed (V1.1)

- [x] Facilitator server (Express, /info, /verify, /health)
- [x] ERC-8004 integration helpers (fhePaymentMethod, fhePaymentProof)
- [x] Virtuals GAME plugin (5 GameFunctions, 28 tests)
- [x] OpenClaw skill (6 scripts, 25 tests)
- [x] ElizaOS example plugin (3 actions)
- [x] React frontend demo (connect, deposit, pay, balance, withdraw)
- [x] Demo scripts (agent-demo, agent-buyer, agent-seller)
- [x] Documentation (LIGHTPAPER, PROTOCOL, ROADMAP)
- [x] CI update (virtuals-plugin, openclaw-skill, frontend jobs)
- [x] Sepolia on-chain integration tests (13 tests, real FHE via Zama coprocessor)

## Completed (V1.2)

- [x] Contract: Pausable (pause/unpause with emergency escape hatches)
- [x] Contract: Treasury withdraw (treasury + owner can withdraw accrued fees to USDC)
- [x] Contract: Withdraw timeout (7-day expiry, anyone can force-expire after timeout)
- [x] Contract: TVL + per-user deposit caps (setPoolCaps, PoolCapExceeded/UserCapExceeded)
- [x] Contract: Payment memo (bytes32 memo in pay() and PaymentExecuted event)
- [x] Contract: Treasury fee migration (setTreasury migrates encrypted balance)
- [x] Contract: BalanceRequested event
- [x] Contract: 33 new V1.2 tests (Pause, Treasury Withdraw, Timeout, Caps, Memo)
- [x] SDK: POOL_ABI updated for V1.2 (memo param, new events, new functions)
- [x] SDK: Error classes (FheX402Error, PaymentError, EncryptionError, TimeoutError, NetworkError)
- [x] SDK: fheFetch retry logic (maxRetries, retryDelayMs with linear backoff)
- [x] SDK: fheFetch timeout (timeoutMs with AbortController)
- [x] SDK: memo option in FhePaymentHandler and FheFetchOptions
- [x] SDK: 85 tests (was 72, +9 error tests, +4 fetch tests)
- [x] Virtuals GAME plugin: fhe_finalize_withdraw + fhe_cancel_withdraw GameFunctions (7 total)
- [x] OpenClaw skill: finalize-withdraw.ts + cancel-withdraw.ts scripts (7 total)
- [x] ElizaOS plugin: FHE_WITHDRAW_FINALIZE + FHE_CANCEL_WITHDRAW actions (5 total)
- [x] Frontend: cancel withdrawal button, transaction history with Etherscan links
- [x] Frontend: V1.2 ABI sync (memo param in pay())
- [x] Infrastructure: .eslintrc.js, .solhintrc.json, .prettierrc, .editorconfig, .nvmrc
- [x] Infrastructure: GitHub issue templates, PR template, CONTRIBUTING.md, dependabot.yml
- [x] Infrastructure: CI lint + security jobs, root package.json scripts
- [x] 245+ total tests (132 contract + 85 SDK + 28+ Virtuals + 25+ OpenClaw)

## Completed (V1.3)

- [x] Redis NonceStore example (examples/redis-nonce-store.ts)
- [x] UUPS proxy upgrade pattern (ConfidentialPaymentPoolUpgradeable + proxy deploy + 9 proxy tests)
- [x] PoolMigrationHelper contract (approve + deposit in one TX)
- [x] Decryption gateway: hardhat task (decrypt-balance), balance gateway server (balanceGateway.ts)
- [x] Frontend: "Request Balance Decryption" button in BalanceDisplay
- [x] Subgraph: schema (7 entities), manifest, mapping (14 event handlers), events-only ABI

## Completed (V2.0)

- [x] Contract: EncryptedErrors — euint8 pay error codes (FHE.or, FHE.select, FHE.asEuint8)
- [x] Contract: Confidential Payment Routing — eaddress (FHE.eq, FHE.ne, FHE.select, FHE.asEaddress, FHE.fromExternal)
- [x] Contract: Encrypted Fee Calculation — FHE.mul, FHE.div(scalar), FHE.max
- [x] Contract: FHE.randEuint64() — random salt in payConfidential
- [x] Contract: FHE.min in requestWithdraw (caps to balance instead of 0)
- [x] Contract: Payment Counter — euint32 (FHE.add, FHE.asEuint32)
- [x] Contract: payConfidential() — encrypted recipient + amount, escrow pattern
- [x] Contract: claimPayment() — encrypted address match for claim
- [x] Contract: _calculateEncryptedFee() — fully encrypted fee calculation
- [x] Contract: 29 FHE op+type combos across 5 encrypted types (ebool, euint8, euint32, euint64, eaddress)
- [x] Contract: Upgradeable variant (V2.0) — mirrored all features, __gap reduced to 46
- [x] Tests: 24 new V2.0 tests (EncryptedErrors, Routing, Fee, Min, Counter)
- [x] Tests: 2 new proxy V2.0 tests (error recording, payment count through proxy)
- [x] Tests: Updated withdraw test for FHE.min semantics
- [x] SDK: addAddress in FhevmEncryptedInput, POOL_ABI updated for V2.0
- [x] SDK: createConfidentialPayment + claimPayment methods
- [x] SDK: PayErrorCode enum, ConfidentialPayResult, ClaimPaymentResult types
- [x] SDK: 8 new handler tests (confidential pay + claim)
- [x] Frontend: ConfidentialPayForm component (encrypted recipient)
- [x] Frontend: ClaimForm component (claim by payment ID)
- [x] Frontend: BalanceDisplay — confidential payment count, payment counter, error display

## Completed (V2.1)

- [x] Contract: Spending Limit — encrypted daily limit (FHE.gt for overLimit, FHE.not for withinLimit)
- [x] Contract: setSpendingLimit(externalEuint64) and removeSpendingLimit()
- [x] Contract: Daily spent tracking with automatic period reset (SPENDING_PERIOD = 1 day)
- [x] Contract: Fee Rounding — FHE.rem to detect remainder, round up fee by 1 to prevent dust loss
- [x] Contract: Error Diagnostic — FHE.not for condition inversion, FHE.xor for exactly-one-error detection
- [x] Contract: Error code expanded to bit flags (1=insufficient, 2=belowMin, 4=overLimit)
- [x] Contract: lastPayExactlyOneError(address) view
- [x] Contract: spendingLimitOf(address), dailySpentOf(address) views
- [x] Contract: Spending limit enforced in both pay() and payConfidential()
- [x] Contract: V2.1 mirrored in ConfidentialPaymentPoolUpgradeable (__gap reduced to 40)
- [x] Tests: 9 new V2.1 tests (4 spending limit + 2 fee rounding + 3 xor diagnostic)
- [x] SDK: PayErrorCode.OVER_SPENDING_LIMIT (4) + new ABI entries + events

## Completed (V3.0)

- [x] Contract: Migrate to ERC-7984 (OpenZeppelin Confidential Contracts)
- [x] Contract: Inherit ERC7984 base (confidentialBalanceOf, confidentialTransfer, setOperator, isOperator)
- [x] Contract: Replace custom _balances with ERC7984 _mint/_burn/_update
- [x] Contract: Inherit Ownable2Step (2-step ownership transfer)
- [x] Contract: Inherit Pausable (standard pause/unpause)
- [x] Contract: Pre-check FHE.isInitialized() before _update()/_burn() to preserve silent failure
- [x] Contract: Remove custom balanceOf, isInitialized, requestBalance, balanceSnapshotOf
- [x] Contract: ERC-7984 fee-free confidentialTransfer (standard) vs pay() (x402 protocol fees)
- [x] Interface: Remove OZ-inherited events/errors/functions from IConfidentialPaymentPool
- [x] Tests: Update all test files (balanceOf to confidentialBalanceOf, OZ error names)
- [x] SDK: POOL_ABI updated for ERC-7984
- [x] Frontend: BalanceDisplay uses confidentialBalanceOf

## Completed (V4.0 — Token-Centric Rewrite)

- [x] Contract: ConfidentialUSDC (ERC-7984 + ERC7984ERC20Wrapper + fee layer)
- [x] Contract: X402PaymentVerifier (nonce registry with minPrice)
- [x] Contract: Remove pool — agents hold cUSDC directly
- [x] Contract: wrap/unwrap with fee, confidentialTransfer fee-free
- [x] Contract: IConfidentialUSDC interface (fee + admin only, ERC-7984 inherited)
- [x] Contract: 78 tests (ConfidentialUSDC, X402PaymentVerifier, E2E)
- [x] SDK: tokenAddress + verifierAddress (replaces poolAddress)
- [x] SDK: Dual-TX pattern (confidentialTransfer + recordPayment)
- [x] SDK: Dual event verification (ConfidentialTransfer + PaymentVerified)
- [x] SDK: 84 tests
- [x] Virtuals plugin: 5 GameFunctions (fhe_wrap, fhe_pay, fhe_unwrap, fhe_balance, fhe_info) — 30 tests
- [x] OpenClaw skill: 6 scripts (wrap, pay, unwrap, balance, info, _wallet) — 25 tests
- [x] Frontend: React + Vite + fhevmjs/web (wrap/pay/unwrap UI)
- [x] Deployed on Sepolia: ConfidentialUSDC, X402PaymentVerifier, MockUSDC (all verified)
- [x] 217 total tests (78 contract + 84 SDK + 30 Virtuals + 25 OpenClaw)

## Completed (V4.1 — Bug Fixes + minPrice)

- [x] Contract: minPrice parameter added to recordPayment
- [x] Contract: assert() replaced with if/revert
- [x] Contract: require() + custom error syntax fixed
- [x] Contract: _unwrapRecipients cleanup (delete in finalizeUnwrap)
- [x] SDK: POOL_CAP_EXCEEDED dead error code removed
- [x] Documentation: README.md rewritten for V4.0
- [x] Documentation: PROTOCOL.md rewritten for V4.0

## In Progress

- [ ] Demo video recording (5-minute walkthrough)
- [ ] LIGHTPAPER.md update for V4.0 token-centric architecture
- [ ] SECURITY.md update for V4.0

## Planned (V5.0 — Production Polish)

- [ ] ESLint v10 migration (eslint.config.js flat config)
- [ ] Frontend overhaul (responsive design, loading states, error handling)
- [ ] Vercel auto-deploy for frontend
- [ ] Encrypted reputation score (threshold-based, privacy-preserving)
- [ ] Transfer fee discussion (1-2 bps = 0.01-0.02%)
- [ ] Gas benchmarking report
- [ ] Professional security audit (Trail of Bits / OpenZeppelin / Quantstamp)
- [ ] Bug bounty program (Immunefi / Code4rena)

## Planned (V6.0 — Multi-Chain + Multi-Token)

- [ ] Cross-chain: Zama coprocessor L2 support (Base, Arbitrum) when available
- [ ] Multi-token factory (WETH, DAI wrapped as confidential ERC-7984)
- [ ] Facilitator network (multiple operators, load balancing)
- [ ] Ethereum mainnet deployment
- [ ] Subscription payment model (recurring encrypted payments)
