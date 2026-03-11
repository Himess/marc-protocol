/**
 * Redeploy X402PaymentVerifier V4.3 to Sepolia.
 * Keeps existing MockUSDC and ConfidentialUSDC contracts.
 *
 * Usage: npx hardhat run scripts/redeploy-verifier.ts --network sepolia
 */
import { ethers } from "hardhat";

const CONFIDENTIAL_USDC = "0x3864B98D1B1EC2109C679679052e2844b4153889";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", await deployer.getAddress());

  const balance = await ethers.provider.getBalance(deployer.getAddress());
  console.log("ETH Balance:", ethers.formatEther(balance));

  // Deploy new X402PaymentVerifier with trustedToken
  console.log("\nDeploying X402PaymentVerifier V4.3...");
  console.log("  trustedToken:", CONFIDENTIAL_USDC);

  const Verifier = await ethers.getContractFactory("X402PaymentVerifier");
  const verifier = await Verifier.deploy(CONFIDENTIAL_USDC);
  await verifier.waitForDeployment();

  const verifierAddress = await verifier.getAddress();
  console.log("  X402PaymentVerifier V4.3:", verifierAddress);

  // Verify deployment
  const trustedToken = await verifier.trustedToken();
  console.log("  trustedToken():", trustedToken);
  console.log("  Match:", trustedToken.toLowerCase() === CONFIDENTIAL_USDC.toLowerCase());

  console.log("\n--- Update these addresses ---");
  console.log(`X402PaymentVerifier: ${verifierAddress}`);
  console.log("\nUpdate in:");
  console.log("  - sdk/src/types.ts (if hardcoded)");
  console.log("  - packages/openclaw-skill/scripts/_wallet.ts");
  console.log("  - packages/virtuals-plugin/src/fhePlugin.ts (if hardcoded)");
  console.log("  - docs/PROTOCOL.md, README.md, LIGHTPAPER.md");
  console.log("  - test/Sepolia.onchain.test.ts");
  console.log("  - frontend/src/App.tsx");
}

main().catch(console.error);
