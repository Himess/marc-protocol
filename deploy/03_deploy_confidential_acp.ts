import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const TOKEN = "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D";
  const TREASURY = "0xF505e2E71df58D7244189072008f25f6b6aaE5ae";

  console.log("Deploying ConfidentialACP with deployer:", deployer);

  const result = await deploy("ConfidentialACP", {
    from: deployer,
    args: [TOKEN, TREASURY],
    log: true,
    waitConfirmations: 2,
  });

  console.log("ConfidentialACP deployed to:", result.address);

  // Verify on Etherscan
  if (hre.network.name === "sepolia") {
    try {
      await hre.run("verify:verify", {
        address: result.address,
        constructorArguments: [TOKEN, TREASURY],
      });
      console.log("Verified on Etherscan!");
    } catch (e: any) {
      console.log("Verification failed:", e.message);
    }
  }
};

func.tags = ["ConfidentialACP"];
export default func;
