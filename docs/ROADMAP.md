# FHE x402 — Roadmap

## V1.0 — Core Protocol (Complete)

- ConfidentialPaymentPool with FHE encrypted balances
- Silent failure pattern for amount privacy
- Protocol fee: max(0.1%, $0.01 minimum)
- 2-step async withdrawal via KMS
- TypeScript SDK: payment handler, paywall middleware, auto-402 fetch
- 138 tests (86 contract + 52 SDK)
- Deployed and verified on Ethereum Sepolia
- Security audit: 11 findings fixed

## V1.1 — Agent Ecosystem (Complete)

- Facilitator server with x402-standard endpoints
- ERC-8004 integration helpers
- Virtuals GAME plugin (5 GameFunctions)
- OpenClaw skill (6 scripts)
- ElizaOS example plugin
- React frontend demo
- Demo scripts (terminal demo, buyer/seller examples)
- Documentation (Lightpaper, Protocol spec, Roadmap)
- 210+ tests across all packages
- CI/CD for all packages

## V1.2 — Production Ready (Planned)

- Professional security audit (Trail of Bits / OpenZeppelin level)
- Ethereum mainnet deployment
- Gas optimization pass
- Redis NonceStore reference implementation
- Monitoring and alerting setup
- Rate limiting with persistent store (Redis)

## V2.0 — Multi-Chain (Planned)

- L2 deployment: Base Sepolia → Base Mainnet
- L2 deployment: Arbitrum
- Multi-token support (USDC, WETH, DAI)
- Browser-friendly decryption gateway (balance checking without full KMS)
- Subscription payment model (recurring encrypted payments)
- Facilitator deployment and documentation

## V2.1 — Scale (Planned)

- Facilitator network (multiple operators, load balancing)
- Batch payments (pay N recipients in one transaction)
- Agent fleet management SDK
- Governance token for treasury and parameter management
- Cross-chain encrypted payments (bridge integration)

## Long-term Vision

FHE x402 aims to become the standard amount-privacy layer for x402 payments on Ethereum and L2s. While ZK-based solutions (PrivAgent) provide full privacy, FHE x402 offers a simpler alternative for agents that need amount privacy without the complexity of UTXO management and trusted setup ceremonies.

The two approaches are complementary:
- **FHE x402**: Amount privacy, public participants, no trusted setup, simpler integration
- **PrivAgent**: Full privacy (amounts + participants), ZK-UTXO, requires circuits
