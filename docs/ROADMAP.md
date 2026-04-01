# MARC Protocol -- Roadmap

## v1.0.0 (Current)

Initial public release.

- **7 contracts:** ConfidentialUSDC (ERC-7984), X402PaymentVerifier, AgenticCommerceProtocol (ERC-8183), AgentIdentityRegistry (ERC-8004), AgentReputationRegistry (ERC-8004), MARCTimelock, MockUSDC
- **SDK:** marc-protocol-sdk on npm -- fheFetch, fhePaywall, facilitator server, ERC-8004/8183 helpers, Redis nonce and batch credit stores
- **6 framework plugins:** x402 Scheme, MCP Server, MPP Method, AgentKit Plugin, Virtuals GAME Plugin, OpenClaw Skill
- **Infrastructure:** Deployed on Ethereum Sepolia, 900+ tests, GitHub Actions CI/CD, The Graph subgraph
- **Security:** Ownable2Step, ReentrancyGuard, Pausable, 48h governance timelock, nonce replay prevention, per-IP rate limiting, EIP-191 signature verification

## v1.1 (Next)

Ethereum mainnet deployment and production hardening.

- Ethereum mainnet deployment with real Zama KMS
- Professional third-party security audit
- UUPS proxy pattern for contract upgradeability
- Multisig treasury (Gnosis Safe 2/3 or 3/5)
- Gas benchmark report (wrap/transfer/unwrap/escrow costs)
- Formal verification (Certora or Halmos)
- Bug bounty program

## v1.2

Multi-chain expansion across EVM L2s.

- **Base deployment** -- #1 chain for x402 volume (Coinbase ecosystem)
- **Arbitrum deployment** -- Largest L2 by TVL
- Multi-token factory (cWETH, cDAI confidential wrappers)
- Facilitator network (decentralized verification service)
- LangChain / CrewAI / AutoGPT agent framework integrations

## v2.0

Multi-VM expansion beyond EVM.

- **Solana (SVM) deployment** -- Largest non-EVM agent ecosystem (Zama roadmap)
- Cross-VM confidential transfers
- Wherever Zama deploys FHE, MARC follows
