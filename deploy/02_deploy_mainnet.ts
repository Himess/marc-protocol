import type { DeployFunction } from "hardhat-deploy/types";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

/**
 * MARC Protocol — Ethereum Mainnet Deployment
 *
 * Deploys:
 *   1. MARCTimelock (governance)
 *   2. ConfidentialUSDC (ERC-7984 token wrapper)
 *   3. X402PaymentVerifier (nonce registry)
 *   4. AgenticCommerceProtocol (ERC-8183 escrow)
 *   5. AgentIdentityRegistry (ERC-8004)
 *   6. AgentReputationRegistry (ERC-8004)
 *
 * Post-deploy:
 *   - Transfer ownership of ConfidentialUSDC + ACP to Timelock
 *   - Transfer ownership of registries to Safe
 *
 * Requirements:
 *   - MAINNET_RPC_URL set in .env
 *   - PRIVATE_KEY set in .env (deployer EOA with ETH for gas)
 *   - SAFE_ADDRESS set in .env (Gnosis Safe multisig)
 */

// Ethereum Mainnet USDC (Circle)
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// Timelock: 48 hours in seconds
const TIMELOCK_DELAY = 48 * 60 * 60; // 172800

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const safeAddress = process.env.SAFE_ADDRESS;
  if (!safeAddress) {
    throw new Error("SAFE_ADDRESS must be set in .env (Gnosis Safe multisig address)");
  }

  const network = hre.network.name;
  if (network !== "mainnet") {
    throw new Error(`This script is for mainnet only. Current network: ${network}`);
  }

  console.log(`\n══════════════════════════════════════════`);
  console.log(`  MARC Protocol — Mainnet Deployment`);
  console.log(`══════════════════════════════════════════`);
  console.log(`  Deployer:  ${deployer}`);
  console.log(`  Safe:      ${safeAddress}`);
  console.log(`  USDC:      ${MAINNET_USDC}`);
  console.log(`  Timelock:  ${TIMELOCK_DELAY}s (48h)`);
  console.log(`══════════════════════════════════════════\n`);

  // 1. Deploy MARCTimelock
  console.log("1/6 Deploying MARCTimelock...");
  const timelock = await deploy("MARCTimelock", {
    from: deployer,
    args: [
      TIMELOCK_DELAY,
      [safeAddress],         // proposers: Safe only
      [safeAddress],         // executors: Safe only
      "0x0000000000000000000000000000000000000000", // admin: renounced
    ],
    log: true,
  });
  console.log(`   MARCTimelock: ${timelock.address}`);

  // 2. Deploy ConfidentialUSDC (treasury = Safe)
  console.log("2/6 Deploying ConfidentialUSDC...");
  const token = await deploy("ConfidentialUSDC", {
    from: deployer,
    args: [MAINNET_USDC, safeAddress], // treasury = Gnosis Safe
    log: true,
  });
  console.log(`   ConfidentialUSDC: ${token.address}`);

  // 3. Deploy X402PaymentVerifier
  console.log("3/6 Deploying X402PaymentVerifier...");
  const verifier = await deploy("X402PaymentVerifier", {
    from: deployer,
    args: [token.address],
    log: true,
  });
  console.log(`   X402PaymentVerifier: ${verifier.address}`);

  // 4. Deploy AgenticCommerceProtocol (paymentToken = USDC, treasury = Safe)
  console.log("4/6 Deploying AgenticCommerceProtocol...");
  const acp = await deploy("AgenticCommerceProtocol", {
    from: deployer,
    args: [MAINNET_USDC, safeAddress],
    log: true,
  });
  console.log(`   AgenticCommerceProtocol: ${acp.address}`);

  // 5. Deploy AgentIdentityRegistry
  console.log("5/6 Deploying AgentIdentityRegistry...");
  const identity = await deploy("AgentIdentityRegistry", {
    from: deployer,
    args: [],
    log: true,
  });
  console.log(`   AgentIdentityRegistry: ${identity.address}`);

  // 6. Deploy AgentReputationRegistry (takes verifier address for proof-of-payment validation)
  console.log("6/6 Deploying AgentReputationRegistry...");
  const reputation = await deploy("AgentReputationRegistry", {
    from: deployer,
    args: [verifier.address],
    log: true,
  });
  console.log(`   AgentReputationRegistry: ${reputation.address}`);

  // ── Ownership Transfers ──────────────────────────────────────────────────

  console.log("\n── Transferring Ownership ──");

  // ConfidentialUSDC → Timelock (critical: controls treasury + pause)
  const tokenContract = await hre.ethers.getContractAt("ConfidentialUSDC", token.address);
  const tx1 = await tokenContract.transferOwnership(timelock.address);
  await tx1.wait();
  console.log(`   ConfidentialUSDC owner → Timelock ✓`);

  // ACP → Timelock (critical: controls treasury + pause)
  const acpContract = await hre.ethers.getContractAt("AgenticCommerceProtocol", acp.address);
  const tx2 = await acpContract.transferOwnership(timelock.address);
  await tx2.wait();
  console.log(`   ACP owner → Timelock ✓`);

  // Identity Registry → Safe (low risk, no timelock needed)
  const identityContract = await hre.ethers.getContractAt("AgentIdentityRegistry", identity.address);
  const tx3 = await identityContract.transferOwnership(safeAddress);
  await tx3.wait();
  console.log(`   IdentityRegistry owner → Safe ✓`);

  // Reputation Registry → Safe (low risk, no timelock needed)
  const reputationContract = await hre.ethers.getContractAt("AgentReputationRegistry", reputation.address);
  const tx4 = await reputationContract.transferOwnership(safeAddress);
  await tx4.wait();
  console.log(`   ReputationRegistry owner → Safe ✓`);

  // NOTE: Timelock uses Ownable2Step — the Safe must call acceptOwnership()
  // on ConfidentialUSDC and ACP via the Timelock to complete the transfer.
  console.log(`\n   ⚠️  Safe must call acceptOwnership() on ConfidentialUSDC & ACP`);
  console.log(`      via the Timelock to finalize ownership transfer.`);

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log("\n══════════════════════════════════════════");
  console.log("  MAINNET DEPLOYMENT SUMMARY");
  console.log("══════════════════════════════════════════");
  console.log(`  MARCTimelock:          ${timelock.address}`);
  console.log(`  ConfidentialUSDC:      ${token.address}`);
  console.log(`  X402PaymentVerifier:   ${verifier.address}`);
  console.log(`  AgenticCommerceProtocol: ${acp.address}`);
  console.log(`  AgentIdentityRegistry: ${identity.address}`);
  console.log(`  AgentReputationRegistry: ${reputation.address}`);
  console.log(`  Treasury (Safe):       ${safeAddress}`);
  console.log(`  USDC:                  ${MAINNET_USDC}`);
  console.log("══════════════════════════════════════════\n");

  // ── Etherscan Verification ─────────────────────────────────────────────

  console.log("── Verifying contracts on Etherscan ──\n");

  const contracts = [
    {
      name: "MARCTimelock",
      address: timelock.address,
      constructorArguments: [
        TIMELOCK_DELAY,
        [safeAddress],
        [safeAddress],
        "0x0000000000000000000000000000000000000000",
      ],
    },
    {
      name: "ConfidentialUSDC",
      address: token.address,
      constructorArguments: [MAINNET_USDC, safeAddress],
    },
    {
      name: "X402PaymentVerifier",
      address: verifier.address,
      constructorArguments: [token.address],
    },
    {
      name: "AgenticCommerceProtocol",
      address: acp.address,
      constructorArguments: [MAINNET_USDC, safeAddress],
    },
    {
      name: "AgentIdentityRegistry",
      address: identity.address,
      constructorArguments: [],
    },
    {
      name: "AgentReputationRegistry",
      address: reputation.address,
      constructorArguments: [verifier.address],
    },
  ];

  for (const c of contracts) {
    try {
      console.log(`   Verifying ${c.name} at ${c.address}...`);
      await hre.run("verify:verify", {
        address: c.address,
        constructorArguments: c.constructorArguments,
      });
      console.log(`   ${c.name} verified successfully`);
    } catch (err: any) {
      if (err.message?.includes("Already Verified")) {
        console.log(`   ${c.name} already verified`);
      } else {
        console.log(`   ${c.name} verification failed: ${err.message}`);
      }
    }
  }

  console.log("\n── Etherscan verification complete ──\n");
};

func.tags = ["mainnet"];
export default func;
