import type { DeployFunction } from "hardhat-deploy/types";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { ethers } from "hardhat";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const isTestnet = hre.network.name === "hardhat" || hre.network.name === "sepolia";

  let usdcAddress: string;

  if (isTestnet) {
    // Use existing MockUSDC deployment
    const mockUsdc = await hre.deployments.get("MockUSDC");
    usdcAddress = mockUsdc.address;
    console.log(`Using MockUSDC at: ${usdcAddress}`);
  } else {
    throw new Error("Set mainnet USDC address before deploying to mainnet");
  }

  // Deploy implementation contract
  console.log("Deploying ConfidentialPaymentPoolUpgradeable implementation...");
  const impl = await deploy("ConfidentialPaymentPoolUpgradeable", {
    from: deployer,
    args: [],
    log: true,
  });
  console.log(`Implementation deployed at: ${impl.address}`);

  // Encode initialize calldata
  const implFactory = await ethers.getContractFactory("ConfidentialPaymentPoolUpgradeable");
  const initData = implFactory.interface.encodeFunctionData("initialize", [
    usdcAddress,
    deployer, // treasury = deployer initially
  ]);

  // Deploy ERC1967Proxy
  console.log("Deploying ERC1967Proxy...");
  const proxy = await deploy("ConfidentialPaymentPoolProxy", {
    from: deployer,
    contract: "ERC1967Proxy",
    args: [impl.address, initData],
    log: true,
  });
  console.log(`Proxy deployed at: ${proxy.address}`);

  // Approve pool to spend deployer's USDC
  const MockUSDC = await ethers.getContractAt("MockUSDC", usdcAddress);
  const approveTx = await MockUSDC.approve(proxy.address, 1_000_000_000_000n);
  await approveTx.wait();
  console.log("Approved proxy pool to spend deployer's USDC");
};

func.tags = ["ConfidentialPaymentPoolProxy"];
func.dependencies = ["ConfidentialPaymentPool"]; // needs MockUSDC from 01
export default func;
