import { expect } from "chai";
import { ethers } from "hardhat";
import { fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("FHE x402 — E2E Demo", function () {
  it("full flow: deploy → deposit → pay → query → withdraw", async function () {
    console.log("\n═══════════════════════════════════════");
    console.log("  FHE x402 Payment Protocol — Demo");
    console.log("═══════════════════════════════════════\n");

    const signers = await ethers.getSigners();
    const deployer = signers[0];
    const alice = signers[1];
    const bob = signers[2];
    const treasury = signers[3];

    // 1. Deploy
    console.log("Step 1: Deploying contracts...");
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();
    const usdcAddress = await usdc.getAddress();

    const Pool = await ethers.getContractFactory("ConfidentialPaymentPool");
    const pool = await Pool.deploy(usdcAddress, treasury.address);
    await pool.waitForDeployment();
    const poolAddress = await pool.getAddress();
    console.log(`  MockUSDC: ${usdcAddress}`);
    console.log(`  Pool: ${poolAddress}\n`);

    // 2. Fund & deposit
    console.log("Step 2: Funding Alice and depositing...");
    await usdc.mint(alice.address, 100_000_000n);
    await usdc.connect(alice).approve(poolAddress, 100_000_000n);
    await pool.connect(alice).deposit(50_000_000);

    const aliceEnc1 = await pool.balanceOf(alice.address);
    const aliceBal1 = await fhevm.userDecryptEuint(FhevmType.euint64, aliceEnc1, poolAddress, alice);
    console.log(`  Alice encrypted balance: ${Number(aliceBal1) / 1_000_000} USDC`);
    expect(aliceBal1).to.equal(49_950_000n);

    // 3. Pay
    console.log("\nStep 3: Alice pays Bob (5 USDC encrypted)...");
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(5_000_000n);
    const encrypted = await input.encrypt();

    const tx = await pool.connect(alice).pay(
      bob.address,
      encrypted.handles[0],
      encrypted.inputProof,
      5_000_000,
      nonce,
      ethers.ZeroHash
    );
    const receipt = await tx.wait();
    console.log(`  TX hash: ${tx.hash}`);
    console.log(`  Nonce: ${nonce}`);

    const payEvent = receipt!.logs.find((log: any) => {
      try {
        const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
        return parsed?.name === "PaymentExecuted";
      } catch {
        return false;
      }
    });
    expect(payEvent).to.not.be.undefined;
    console.log(`  PaymentExecuted event: YES`);

    // 4. Query
    console.log("\nStep 4: Querying encrypted balances...");
    const aliceEnc2 = await pool.balanceOf(alice.address);
    const aliceBal2 = await fhevm.userDecryptEuint(FhevmType.euint64, aliceEnc2, poolAddress, alice);
    console.log(`  Alice: ${Number(aliceBal2) / 1_000_000} USDC`);
    expect(aliceBal2).to.equal(44_950_000n); // 49_950_000 - 5_000_000

    const bobEnc = await pool.balanceOf(bob.address);
    const bobBal = await fhevm.userDecryptEuint(FhevmType.euint64, bobEnc, poolAddress, bob);
    console.log(`  Bob: ${Number(bobBal) / 1_000_000} USDC`);
    // Bob gets 5_000_000 - fee(10_000) = 4_990_000
    expect(bobBal).to.equal(4_990_000n);

    const treasuryEnc = await pool.balanceOf(treasury.address);
    const treasuryBal = await fhevm.userDecryptEuint(FhevmType.euint64, treasuryEnc, poolAddress, treasury);
    console.log(`  Treasury: ${Number(treasuryBal) / 1_000_000} USDC`);
    // deposit fee (50_000) + pay fee (10_000) = 60_000
    expect(treasuryBal).to.equal(60_000n);

    // 5. Withdraw
    console.log("\nStep 5: Bob requests withdrawal...");
    const wInput = fhevm.createEncryptedInput(poolAddress, bob.address);
    wInput.add64(bobBal);
    const wEncrypted = await wInput.encrypt();
    await pool.connect(bob).requestWithdraw(wEncrypted.handles[0], wEncrypted.inputProof);
    expect(await pool.withdrawRequested(bob.address)).to.equal(true);
    console.log(`  Withdraw requested for ${Number(bobBal) / 1_000_000} USDC`);

    console.log("\n═══════════════════════════════════════");
    console.log("  Demo Complete! Scheme: fhe-confidential-v1");
    console.log("═══════════════════════════════════════\n");
  });
});
