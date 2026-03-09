import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

task("decrypt-balance", "Decrypt a user's pool balance via FHE KMS")
  .addParam("address", "The user address to decrypt balance for")
  .setAction(async (taskArgs: { address: string }, hre: HardhatRuntimeEnvironment) => {
    const { ethers, fhevm } = hre;
    const { FhevmType } = await import("@fhevm/hardhat-plugin");

    const poolDeployment = await hre.deployments.get("ConfidentialPaymentPool");
    const pool = await ethers.getContractAt("ConfidentialPaymentPool", poolDeployment.address);

    const userAddress = taskArgs.address;
    console.log(`Decrypting balance for: ${userAddress}`);

    // Check if user is initialized
    const isInit = await pool.isInitialized(userAddress);
    if (!isInit) {
      console.log("User has no initialized balance in pool.");
      return;
    }

    // Request balance snapshot (creates publicly decryptable snapshot)
    console.log("Requesting balance snapshot...");
    const signer = (await ethers.getSigners())[0];

    // Check if there's already a pending query
    const alreadyRequested = await pool.balanceQueryRequested(userAddress);
    if (!alreadyRequested) {
      // Only the user themselves can call requestBalance
      // If the signer is the user, call it directly
      if (signer.address.toLowerCase() === userAddress.toLowerCase()) {
        const tx = await pool.connect(signer).requestBalance();
        await tx.wait();
        console.log("Balance snapshot created.");
      } else {
        console.log("Warning: Signer is not the target user. User must call requestBalance() first.");
        console.log("Checking for existing snapshot...");
      }
    }

    // Read the snapshot handle
    const snapshotHandle = await pool.balanceSnapshotOf(userAddress);
    if (snapshotHandle === ethers.ZeroHash) {
      console.log("No balance snapshot available. User must call requestBalance() first.");
      return;
    }

    // Decrypt via KMS
    console.log("Decrypting via FHE KMS...");
    try {
      const decrypted = await fhevm.publicDecryptEuint(
        FhevmType.euint64,
        snapshotHandle,
        poolDeployment.address,
      );
      const usdc = Number(decrypted) / 1_000_000;
      console.log(`Decrypted balance: ${decrypted} (${usdc.toFixed(6)} USDC)`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.log(`Decryption failed: ${msg}`);
      console.log("The snapshot may not be ready for decryption yet. Try again in a few blocks.");
    }
  });
