import type { DeployFunction } from "hardhat-deploy/types";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const isTestnet = hre.network.name === "hardhat" || hre.network.name === "sepolia";

  let usdcAddress: string;

  if (isTestnet) {
    console.log("Deploying MockUSDC...");
    const mockUsdc = await deploy("MockUSDC", {
      from: deployer,
      args: [],
      log: true,
    });
    usdcAddress = mockUsdc.address;
    console.log(`MockUSDC deployed at: ${usdcAddress}`);

    // Mint test USDC to deployer
    const MockUSDC = await hre.ethers.getContractAt("MockUSDC", usdcAddress);
    const mintTx = await MockUSDC.mint(deployer, 1_000_000_000_000n); // 1M USDC (6 decimals)
    await mintTx.wait();
    console.log(`Minted 1,000,000 USDC to deployer: ${deployer}`);
  } else {
    throw new Error("Set mainnet USDC address before deploying to mainnet");
  }

  // Deploy ConfidentialUSDC (ERC-7984 token)
  console.log("Deploying ConfidentialUSDC...");
  const token = await deploy("ConfidentialUSDC", {
    from: deployer,
    args: [usdcAddress, deployer], // treasury = deployer
    log: true,
  });
  console.log(`ConfidentialUSDC deployed at: ${token.address}`);

  // Deploy X402PaymentVerifier (nonce registry)
  // V4.3: constructor takes trustedToken address
  console.log("Deploying X402PaymentVerifier...");
  const verifier = await deploy("X402PaymentVerifier", {
    from: deployer,
    args: [token.address],
    log: true,
  });
  console.log(`X402PaymentVerifier deployed at: ${verifier.address}`);

  // Approve ConfidentialUSDC to spend deployer's USDC
  const MockUSDC = await hre.ethers.getContractAt("MockUSDC", usdcAddress);
  const approveTx = await MockUSDC.approve(token.address, 1_000_000_000_000n);
  await approveTx.wait();
  console.log("Approved ConfidentialUSDC to spend deployer's USDC");

  console.log("\n--- V4.0 Deployment Summary ---");
  console.log(`MockUSDC:            ${usdcAddress}`);
  console.log(`ConfidentialUSDC:    ${token.address}`);
  console.log(`X402PaymentVerifier: ${verifier.address}`);
  console.log(`Treasury:            ${deployer}`);
};

func.tags = ["ConfidentialUSDC", "X402PaymentVerifier"];
export default func;
