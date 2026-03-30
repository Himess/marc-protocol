# MARC Protocol — Deployment Runbook

## Prerequisites

### Keys and Accounts

| Item | Description |
|------|-------------|
| Deployer EOA | Private key with ETH for gas. Used for initial deployment only. |
| Gnosis Safe | Multisig wallet address for treasury + governance. Set as `SAFE_ADDRESS` in `.env`. |
| RPC endpoint | Alchemy, Infura, or similar. Mainnet: `MAINNET_RPC_URL`. Testnet: `SEPOLIA_RPC_URL`. |
| Etherscan API key | For contract verification. Set as `ETHERSCAN_API_KEY` in `.env`. |

### Environment Setup

Copy `.env.example` and fill in values:

```bash
cp .env.example .env
```

Required variables:

```env
PRIVATE_KEY=0x_YOUR_DEPLOYER_PRIVATE_KEY
ETHERSCAN_API_KEY=YOUR_ETHERSCAN_API_KEY

# Testnet
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com

# Mainnet
MAINNET_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
SAFE_ADDRESS=0x_YOUR_GNOSIS_SAFE_ADDRESS
```

### Software

- Node.js 20+ (`.nvmrc` specifies version)
- Hardhat + hardhat-deploy
- Dependencies installed: `npm install`

---

## Deploy Order

Contracts must be deployed in dependency order. The mainnet script (`deploy/02_deploy_mainnet.ts`) handles this automatically.

```
1. MARCTimelock           — no dependencies
2. ConfidentialUSDC       — depends on USDC address
3. X402PaymentVerifier    — depends on ConfidentialUSDC address
4. AgenticCommerceProtocol — depends on USDC address
5. AgentIdentityRegistry  — no dependencies
6. AgentReputationRegistry — depends on X402PaymentVerifier address
```

### Dependency Graph

```
USDC (external)
  |
  +--> ConfidentialUSDC(usdc, treasury)
  |      |
  |      +--> X402PaymentVerifier(trustedToken = ConfidentialUSDC)
  |             |
  |             +--> AgentReputationRegistry(verifier = X402PaymentVerifier)
  |
  +--> AgenticCommerceProtocol(paymentToken = USDC, treasury)

MARCTimelock(delay, [safe], [safe], 0x0)   -- independent

AgentIdentityRegistry()                     -- independent
```

---

## Testnet Deployment (Sepolia)

For testnet, the script deploys a MockUSDC and mints 1M USDC to the deployer:

```bash
npx hardhat deploy --network sepolia --tags ConfidentialUSDC,X402PaymentVerifier
```

This runs `deploy/01_deploy_pool.ts` which:

1. Deploys `MockUSDC` and mints 1,000,000 USDC to deployer
2. Deploys `ConfidentialUSDC(mockUsdc, deployer)` — treasury set to deployer for testing
3. Deploys `X402PaymentVerifier(confidentialUsdcAddress)`
4. Approves ConfidentialUSDC to spend deployer's USDC

---

## Mainnet Deployment

```bash
npx hardhat deploy --network mainnet --tags mainnet
```

This runs `deploy/02_deploy_mainnet.ts` which:

### Step 1: Deploy MARCTimelock

```
Constructor args:
  - minDelay: 172800 (48 hours)
  - proposers: [SAFE_ADDRESS]
  - executors: [SAFE_ADDRESS]
  - admin: 0x0000...0000 (renounced)
```

### Step 2: Deploy ConfidentialUSDC

```
Constructor args:
  - _usdc: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 (mainnet USDC)
  - _treasury: SAFE_ADDRESS
```

Constructor validates:
- USDC has 6 decimals
- Conversion rate is 1
- Treasury is not zero address

### Step 3: Deploy X402PaymentVerifier

```
Constructor args:
  - _trustedToken: ConfidentialUSDC address (from step 2)
```

### Step 4: Deploy AgenticCommerceProtocol

```
Constructor args:
  - _paymentToken: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 (mainnet USDC)
  - _treasury: SAFE_ADDRESS
```

Constructor validates:
- Payment token is a deployed contract (code.length > 0)
- Treasury is not zero address

### Step 5: Deploy AgentIdentityRegistry

```
No constructor args.
```

### Step 6: Deploy AgentReputationRegistry

```
Constructor args:
  - _verifier: X402PaymentVerifier address (from step 3)
```

### Step 7: Ownership Transfers

The deploy script initiates `transferOwnership()` on all contracts:

| Contract | New Owner | Reason |
|----------|-----------|--------|
| ConfidentialUSDC | MARCTimelock | Critical: controls treasury, pause, fee parameters |
| AgenticCommerceProtocol | MARCTimelock | Critical: controls treasury, pause |
| AgentIdentityRegistry | Gnosis Safe | Low risk: only controls pause |
| AgentReputationRegistry | Gnosis Safe | Low risk: only controls pause |

### Step 8: Etherscan Verification

The script automatically verifies all 6 contracts on Etherscan. If verification fails (e.g., "Already Verified"), it logs the error and continues.

---

## Ownable2Step Acceptance Flow

ConfidentialUSDC and ACP use `Ownable2Step`. After `transferOwnership()`, the new owner must call `acceptOwnership()` to complete the transfer.

For contracts owned by MARCTimelock, the acceptance flow is:

1. **Deployer** calls `transferOwnership(timelockAddress)` on ConfidentialUSDC and ACP (done by deploy script)
2. **Gnosis Safe** proposes a Timelock operation to call `acceptOwnership()` on each contract
3. After the 48-hour delay, **Gnosis Safe** executes the Timelock operation

```
Timelock.schedule(
  target: ConfidentialUSDC,
  value: 0,
  data: abi.encodeCall(Ownable2Step.acceptOwnership, ()),
  predecessor: bytes32(0),
  salt: bytes32(0),
  delay: 172800
)

// After 48 hours:
Timelock.execute(...)
```

For registries owned by the Gnosis Safe directly, the Safe simply calls `acceptOwnership()`.

**Until acceptOwnership() is called, the deployer EOA remains the owner.** Complete this step promptly after deployment.

---

## Post-Deploy Verification

### Contract State Checks

Run these checks after deployment to verify correct configuration:

```bash
# Verify ConfidentialUSDC
npx hardhat console --network mainnet
> const token = await ethers.getContractAt("ConfidentialUSDC", "0x...")
> await token.treasury()          // Should be SAFE_ADDRESS
> await token.underlying()        // Should be USDC address
> await token.rate()              // Should be 1
> await token.paused()            // Should be false
> await token.owner()             // Should be deployer (until acceptance)
> await token.pendingOwner()      // Should be Timelock address

# Verify X402PaymentVerifier
> const verifier = await ethers.getContractAt("X402PaymentVerifier", "0x...")
> await verifier.trustedToken()   // Should be ConfidentialUSDC address
> await verifier.owner()          // Should be deployer (until acceptance)

# Verify ACP
> const acp = await ethers.getContractAt("AgenticCommerceProtocol", "0x...")
> await acp.paymentToken()        // Should be USDC address
> await acp.treasury()            // Should be SAFE_ADDRESS
> await acp.owner()               // Should be deployer (until acceptance)

# Verify AgentReputationRegistry
> const rep = await ethers.getContractAt("AgentReputationRegistry", "0x...")
> await rep.verifier()            // Should be X402PaymentVerifier address
```

### Etherscan Verification

Confirm all contracts show "Verified" on Etherscan. If automatic verification failed:

```bash
npx hardhat verify --network mainnet CONTRACT_ADDRESS CONSTRUCTOR_ARG1 CONSTRUCTOR_ARG2 ...
```

### Test Transaction

Perform a small wrap + transfer + unwrap cycle on testnet before mainnet:

1. Approve ConfidentialUSDC to spend USDC
2. Wrap 1 USDC via `token.wrap(yourAddress, 1000000)`
3. Transfer cUSDC via `token.confidentialTransfer(recipient, encryptedAmount, proof)`
4. Record payment nonce via `verifier.recordPayment(server, nonce, 1000000)`

---

## Emergency Procedures

### Pause All Operations

All critical contracts have `pause()` / `unpause()` functions. The caller must be the contract owner.

**For ConfidentialUSDC and ACP** (owned by Timelock after acceptance):

Pausing requires a Timelock operation, which has a 48-hour delay. For faster emergency response, consider keeping a pause guardian role (not currently implemented) or using the 1-hour minimum delay.

```
// Propose pause via Timelock
Timelock.schedule(
  target: ConfidentialUSDC,
  value: 0,
  data: abi.encodeCall(Pausable.pause, ()),
  predecessor: bytes32(0),
  salt: keccak256("emergency-pause-001"),
  delay: getMinDelay()
)
```

**For registries** (owned by Gnosis Safe directly):

The Safe can pause immediately via a multisig transaction:

```solidity
identityRegistry.pause();
reputationRegistry.pause();
```

**What pause blocks:**

| Contract | Blocked Operations |
|----------|--------------------|
| ConfidentialUSDC | wrap, unwrap, finalizeUnwrap, confidentialTransfer, confidentialTransferFrom, setOperator, confidentialTransferAndCall |
| X402PaymentVerifier | recordPayment, payAndRecord, recordBatchPayment |
| AgenticCommerceProtocol | createJob, fund, submit, complete, reject, claimRefund |
| AgentIdentityRegistry | register, setAgentWallet, updateURI, deregister |
| AgentReputationRegistry | giveFeedback |

### Treasury Update

If the treasury address is compromised, update it via the Timelock:

```
Timelock.schedule(
  target: ConfidentialUSDC,
  data: abi.encodeCall(ConfidentialUSDC.setTreasury, (newTreasuryAddress)),
  ...
)
```

### Fee Withdrawal

Accumulated wrap/unwrap fees in ConfidentialUSDC can be withdrawn by the treasury or owner:

```solidity
confidentialUSDC.treasuryWithdraw();
```

This transfers all `accumulatedFees` (plaintext USDC) to the treasury address.

### X402PaymentVerifier: Nonce Cancellation

If an agent's payment nonce was recorded but the service was not delivered:

```solidity
// Only the original payer can cancel
verifier.cancelNonce(nonce);
```

### Contract Upgrade Path

V4.3 contracts are not upgradeable (no UUPS proxy). To upgrade:

1. Deploy new contract versions
2. Pause old contracts
3. Migrate state if needed (treasury balance, etc.)
4. Update SDK/frontend to point to new addresses
5. Update `chains.ts` and MCP server `config.ts` with new addresses

---

## Deployed Addresses

### Sepolia (Testnet)

| Contract | Address |
|----------|---------|
| MockUSDC | `0xc89e913676B034f8b38E49f7508803d1cDEC9F4f` |
| ConfidentialUSDC | `0xE944754aa70d4924dc5d8E57774CDf21Df5e592D` |
| X402PaymentVerifier | `0x4503A7aee235aBD10e6064BBa8E14235fdF041f4` |

### Mainnet

Addresses will be populated after mainnet deployment.

---

## SDK / MCP Server Configuration After Deploy

After deploying new contracts, update addresses in:

1. **SDK chains.ts** (`sdk/src/chains.ts`) — `CHAINS` object
2. **MCP server config.ts** (`packages/mcp-server/src/config.ts`) — `SEPOLIA` / `MAINNET` objects
3. **Frontend** — environment variables or config files
4. **Subgraph** — `subgraph.yaml` data sources

---

## Monitoring

### Key Events to Monitor

| Event | Contract | Severity | Action |
|-------|----------|----------|--------|
| `Paused` | Any | Critical | Investigate cause immediately |
| `OwnershipTransferred` | Any | Critical | Verify intended transfer |
| `TreasuryUpdated` | ConfidentialUSDC, ACP | High | Verify new treasury address |
| `TreasuryWithdrawn` | ConfidentialUSDC | Medium | Verify amount and destination |
| `HookFailed` | ACP | Low | Check hook contract for issues |
| `BatchPaymentRecorded` | Verifier | Info | Track batch prepayment activity |

### Health Checks

- Facilitator `/health` endpoint returns `{"status":"ok"}`
- RPC node connectivity (provider.getBlockNumber() succeeds)
- Contract `paused()` returns false
- Treasury address has not been changed unexpectedly
