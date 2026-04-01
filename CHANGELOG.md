# Changelog

## v1.0.0 (April 2026)

Initial public release of MARC Protocol.

### Core Contracts
- ConfidentialUSDC (ERC-7984): FHE-encrypted token with wrap/unwrap and fee-free transfers
- ConfidentialACP (ERC-8183): Job escrow with encrypted budgets and FHE fee calculation
- X402PaymentVerifier: Nonce registry with batch prepayment support
- AgentIdentityRegistry (ERC-8004): On-chain agent identity
- AgentReputationRegistry (ERC-8004): Feedback with proof-of-payment
- MARCTimelock: 48-hour governance delay

### SDK
- marc-protocol-sdk on npm
- fheFetch, fhePaywall, facilitator server
- ERC-8004 and ERC-8183 helper functions
- ConfidentialACP SDK integration
- Redis nonce and batch credit stores

### Framework Plugins
- x402 Scheme (HTTP 402 payment standard)
- MCP Server (6 tools for Claude/LLMs)
- MPP Method (Stripe Machine-Payable Pages)
- AgentKit Plugin (Coinbase)
- Virtuals GAME Plugin (5 GameFunctions)
- OpenClaw Skill (6 CLI scripts)

### Infrastructure
- Deployed on Ethereum Sepolia
- 900+ tests passing
- GitHub Actions CI/CD
- The Graph subgraph
