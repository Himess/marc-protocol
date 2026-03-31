# FHE x402 — Roadmap

## V1.0 — Core Protocol (Complete)

- ConfidentialPaymentPool with FHE encrypted balances
- Silent failure pattern for amount privacy
- Protocol fee: max(0.1%, $0.01 minimum) on all operations
- 2-step async withdrawal via KMS
- TypeScript SDK: payment handler, paywall middleware, auto-402 fetch
- 138 tests (86 contract + 52 SDK) at initial release
- Deployed and verified on Ethereum Sepolia
- Security audit: 11 findings fixed

## V1.1 — Agent Ecosystem (Complete)

- Facilitator server with x402-standard endpoints
- ERC-8004 integration helpers
- Virtuals GAME plugin (5 GameFunctions)
- OpenClaw skill (6 scripts)
- ElizaOS example plugin
- React frontend demo
- 211 tests across all packages

## V1.2 — Production Features (Complete)

- Pausable, treasury withdraw, withdraw timeout, TVL/user caps
- Payment memo (bytes32), treasury fee migration
- SDK: error classes, retry logic, timeout, memo support
- 245+ tests

## V1.3 — Infrastructure (Complete)

- Redis NonceStore example
- UUPS proxy upgrade pattern
- PoolMigrationHelper contract
- Decryption gateway (balance checking)
- Subgraph (7 entities, 14 event handlers)

## V2.0 — Advanced FHE (Complete)

- Encrypted error codes (euint8 bit flags)
- Confidential payment routing (eaddress)
- Fully encrypted fee calculation (FHE.mul, FHE.div, FHE.max)
- Random salt (FHE.randEuint64), payment counter (euint32)
- payConfidential + claimPayment (escrow pattern)
- 29 FHE op+type combos across 5 encrypted types

## V2.1 — Spending Controls (Complete)

- Encrypted daily spending limit
- Fee rounding (FHE.rem, round up by 1)
- Error diagnostic (FHE.xor for exactly-one-error)

## V3.0 — ERC-7984 Migration (Complete)

- Migrated to OpenZeppelin Confidential Contracts (ERC-7984)
- Standard confidentialBalanceOf, confidentialTransfer, setOperator
- Replaced custom _balances with ERC7984 _mint/_burn/_update

## V4.0 — Token-Centric Rewrite (Complete)

- Replaced pool-based architecture with token-centric design
- Two contracts: ConfidentialUSDC (ERC-7984 wrapper) + X402PaymentVerifier (nonce registry)
- Agents hold cUSDC directly (no pool)
- Fee-free confidentialTransfer (fees only on wrap/unwrap)
- Dual-TX payment: confidentialTransfer + recordPayment
- SDK: tokenAddress + verifierAddress (replaces poolAddress)
- Dual event verification (ConfidentialTransfer + PaymentVerified)
- 217 tests (78 contract + 84 SDK + 30 Virtuals + 25 OpenClaw)
- Deployed on Sepolia (all contracts verified on Etherscan)

## V4.1 — Bug Fixes + minPrice (Complete)

- minPrice parameter added to X402PaymentVerifier.recordPayment
- assert()/require() syntax issues fixed in ConfidentialUSDC
- _unwrapRecipients cleanup added to finalizeUnwrap
- Dead error codes removed from SDK
- Documentation fully rewritten for V4.0 architecture

## V4.2 — Single-TX Payment (Complete)

- payAndRecord: single-TX payment via verifier (confidentialTransferFrom + recordPayment)
- confidentialTransferAndCall: composable transfer with arbitrary callback
- SDK: preferSingleTx option for FhePaymentHandler
- Reduced gas overhead by ~40% for single-TX flow
- EIP-191 signature verification on payment payloads

## V4.3 — Batch Prepayment + Agent Commerce (Complete)

- Batch prepayment: recordBatchPayment for N requests at fixed price
- ERC-8183 integration: AgenticCommerceProtocol (job escrow with FHE-encrypted budgets)
- ConfidentialACP: createAndFund, submit, complete, reject, claimRefund lifecycle
- ERC-8004 integration: AgentIdentityRegistry + AgentReputationRegistry
- MCP server with 10 tools for agent-to-agent commerce
- Multi-chain config (Sepolia, Mainnet, Base, Arbitrum addresses)
- 800+ tests across all packages

## V4.4 — Audit Fixes (Complete)

- Security hardening: CORS default changed to block-all, timing-safe comparison improved
- Config consolidation: single source of truth for contract addresses in chains.ts
- FHE encryption deduplication: shared _encryptAmount() helper
- Version consistency across all packages (4.3.0)
- 922 tests passing

## V5.0 — Production Polish (Planned)

- ESLint v10 migration (flat config)
- Frontend overhaul: responsive design, loading states, error handling
- Vercel auto-deploy for frontend
- Encrypted reputation score (threshold-based, privacy-preserving)
- Transfer fee evaluation (1-2 bps discussion)
- Gas benchmarking report
- Professional security audit
- Bug bounty program

## V6.0 — Multi-Chain + Multi-Token (Future)

- Cross-chain deployment when Zama coprocessor L2 support arrives (Base, Arbitrum)
- Multi-token factory: wrap WETH, DAI, and other ERC-20s as confidential ERC-7984 tokens
- Facilitator network (multiple operators, load balancing)
- Ethereum mainnet deployment
- Subscription payment model (recurring encrypted payments)

## Long-term Vision

FHE x402 aims to become the standard amount-privacy layer for x402 payments on Ethereum and L2s. While ZK-based solutions (PrivAgent) provide full privacy, FHE x402 offers a simpler alternative for agents that need amount privacy without the complexity of UTXO management and trusted setup ceremonies.

The two approaches are complementary:
- **FHE x402**: Amount privacy, public participants, no trusted setup, simpler integration
- **PrivAgent**: Full privacy (amounts + participants), ZK-UTXO, requires circuits
