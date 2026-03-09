import { expect } from "chai";
import { ethers } from "hardhat";
import { fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("ConfidentialPaymentPool — Withdraw", function () {
  let pool: any;
  let usdc: any;
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let poolAddress: string;

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    deployer = signers[0];
    alice = signers[1];
    treasury = signers[2];

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    const Pool = await ethers.getContractFactory("ConfidentialPaymentPool");
    pool = await Pool.deploy(await usdc.getAddress(), treasury.address);
    await pool.waitForDeployment();
    poolAddress = await pool.getAddress();

    // Fund alice
    await usdc.mint(alice.address, 100_000_000n);
    await usdc.connect(alice).approve(poolAddress, 100_000_000n);
    await pool.connect(alice).deposit(20_000_000); // fee=20_000, net=19_980_000
  });

  it("should request withdraw successfully", async function () {
    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(5_000_000n);
    const encrypted = await input.encrypt();

    await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);
    expect(await pool.withdrawRequested(alice.address)).to.equal(true);
  });

  it("should emit WithdrawRequested event", async function () {
    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(5_000_000n);
    const encrypted = await input.encrypt();

    const tx = await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);
    const receipt = await tx.wait();

    const event = receipt.logs.find((log: any) => {
      try {
        const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
        return parsed?.name === "WithdrawRequested";
      } catch {
        return false;
      }
    });
    expect(event).to.not.be.undefined;
  });

  it("should revert on double withdraw request", async function () {
    const input1 = fhevm.createEncryptedInput(poolAddress, alice.address);
    input1.add64(1_000_000n);
    const enc1 = await input1.encrypt();
    await pool.connect(alice).requestWithdraw(enc1.handles[0], enc1.inputProof);

    const input2 = fhevm.createEncryptedInput(poolAddress, alice.address);
    input2.add64(1_000_000n);
    const enc2 = await input2.encrypt();

    await expect(
      pool.connect(alice).requestWithdraw(enc2.handles[0], enc2.inputProof)
    ).to.be.revertedWithCustomError(pool, "WithdrawAlreadyRequested");
  });

  it("should deduct balance on withdraw request", async function () {
    const balBefore = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await pool.balanceOf(alice.address),
      poolAddress,
      alice
    );

    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(5_000_000n);
    const encrypted = await input.encrypt();
    await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);

    const balAfter = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await pool.balanceOf(alice.address),
      poolAddress,
      alice
    );
    expect(balBefore - balAfter).to.equal(5_000_000n);
  });

  it("should store pending withdraw amount", async function () {
    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(3_000_000n);
    const encrypted = await input.encrypt();
    await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);

    // The pending withdraw handle should exist
    const pendingHandle = await pool.pendingWithdrawOf(alice.address);
    // It's a handle, not zero
    expect(pendingHandle).to.not.equal(0n);
  });

  it("should revert finalizeWithdraw without request", async function () {
    await expect(
      pool.connect(alice).finalizeWithdraw(1_000_000, "0x")
    ).to.be.revertedWithCustomError(pool, "WithdrawNotRequested");
  });

  it("should cap withdraw to balance on insufficient funds (FHE.min)", async function () {
    // Alice has ~19_980_000 net (20M deposit - 20_000 fee)
    // V2.0: FHE.min caps to balance instead of silently returning 0
    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(50_000_000n); // More than balance
    const encrypted = await input.encrypt();

    await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);

    // Balance should be 0 (entire balance was withdrawn via FHE.min cap)
    const balAfter = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await pool.balanceOf(alice.address),
      poolAddress,
      alice
    );
    expect(balAfter).to.equal(0n);
  });

  it("should handle user with no balance requesting withdraw", async function () {
    const bob = (await ethers.getSigners())[3];
    const input = fhevm.createEncryptedInput(poolAddress, bob.address);
    input.add64(1_000_000n);
    const encrypted = await input.encrypt();

    // Should not revert — silent failure (caps to 0)
    await pool.connect(bob).requestWithdraw(encrypted.handles[0], encrypted.inputProof);
    expect(await pool.withdrawRequested(bob.address)).to.equal(true);
  });

  // ═══════════════════════════════════════
  // cancelWithdraw tests
  // ═══════════════════════════════════════

  it("should cancel withdraw and refund balance", async function () {
    const balBefore = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await pool.balanceOf(alice.address),
      poolAddress,
      alice
    );

    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(5_000_000n);
    const encrypted = await input.encrypt();
    await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);

    // Cancel — should refund
    await pool.connect(alice).cancelWithdraw();

    expect(await pool.withdrawRequested(alice.address)).to.equal(false);

    const balAfter = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await pool.balanceOf(alice.address),
      poolAddress,
      alice
    );
    expect(balAfter).to.equal(balBefore);
  });

  it("should emit WithdrawCancelled event", async function () {
    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(1_000_000n);
    const encrypted = await input.encrypt();
    await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);

    const tx = await pool.connect(alice).cancelWithdraw();
    const receipt = await tx.wait();

    const event = receipt.logs.find((log: any) => {
      try {
        const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
        return parsed?.name === "WithdrawCancelled";
      } catch {
        return false;
      }
    });
    expect(event).to.not.be.undefined;
  });

  it("should revert cancelWithdraw when no request pending", async function () {
    await expect(
      pool.connect(alice).cancelWithdraw()
    ).to.be.revertedWithCustomError(pool, "WithdrawNotRequested");
  });

  it("should allow re-requesting after cancel", async function () {
    const input1 = fhevm.createEncryptedInput(poolAddress, alice.address);
    input1.add64(1_000_000n);
    const enc1 = await input1.encrypt();
    await pool.connect(alice).requestWithdraw(enc1.handles[0], enc1.inputProof);

    await pool.connect(alice).cancelWithdraw();

    // Should be able to request again
    const input2 = fhevm.createEncryptedInput(poolAddress, alice.address);
    input2.add64(2_000_000n);
    const enc2 = await input2.encrypt();
    await pool.connect(alice).requestWithdraw(enc2.handles[0], enc2.inputProof);

    expect(await pool.withdrawRequested(alice.address)).to.equal(true);
  });

  it("should handle cancel after silent failure (0 pending)", async function () {
    const bob = (await ethers.getSigners())[3];
    const input = fhevm.createEncryptedInput(poolAddress, bob.address);
    input.add64(1_000_000n);
    const encrypted = await input.encrypt();

    // Bob has no balance → silent failure → 0 pending
    await pool.connect(bob).requestWithdraw(encrypted.handles[0], encrypted.inputProof);
    expect(await pool.withdrawRequested(bob.address)).to.equal(true);

    // Cancel — adds 0 back, harmless
    await pool.connect(bob).cancelWithdraw();
    expect(await pool.withdrawRequested(bob.address)).to.equal(false);
  });

  // ═══════════════════════════════════════
  // finalizeWithdraw positive path
  // Uses fhevm.publicDecrypt() to get valid KMS mock proof
  // ═══════════════════════════════════════

  it("should finalize withdraw with KMS proof (mock)", async function () {
    const withdrawAmount = 5_000_000n;

    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(withdrawAmount);
    const encrypted = await input.encrypt();
    await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);

    // Get pending handle and use publicDecrypt for mock KMS proof
    const pendingHandle = await pool.pendingWithdrawOf(alice.address);
    const decryptResult = await fhevm.publicDecrypt([pendingHandle]);
    const clearAmount = BigInt(decryptResult.clearValues[pendingHandle]);
    const proof = decryptResult.decryptionProof;

    const usdcBefore = await usdc.balanceOf(alice.address);

    await pool.connect(alice).finalizeWithdraw(Number(clearAmount), proof);

    expect(await pool.withdrawRequested(alice.address)).to.equal(false);

    // Alice should have received USDC minus withdrawal fee
    // fee = max(5_000_000*10/10_000, 10_000) = max(5_000, 10_000) = 10_000
    // net = 5_000_000 - 10_000 = 4_990_000
    const usdcAfter = await usdc.balanceOf(alice.address);
    expect(usdcAfter - usdcBefore).to.equal(4_990_000n);
  });

  it("should emit WithdrawFinalized event", async function () {
    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(2_000_000n);
    const encrypted = await input.encrypt();
    await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);

    const pendingHandle = await pool.pendingWithdrawOf(alice.address);
    const decryptResult = await fhevm.publicDecrypt([pendingHandle]);
    const clearAmount = BigInt(decryptResult.clearValues[pendingHandle]);
    const proof = decryptResult.decryptionProof;

    const tx = await pool.connect(alice).finalizeWithdraw(Number(clearAmount), proof);
    const receipt = await tx.wait();

    const event = receipt.logs.find((log: any) => {
      try {
        const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
        return parsed?.name === "WithdrawFinalized";
      } catch {
        return false;
      }
    });
    expect(event).to.not.be.undefined;
  });

  it("should credit withdrawal fee to treasury", async function () {
    const treasuryBalBefore = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await pool.balanceOf(treasury.address),
      poolAddress,
      treasury
    );

    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(10_000_000n);
    const encrypted = await input.encrypt();
    await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);

    const pendingHandle = await pool.pendingWithdrawOf(alice.address);
    const decryptResult = await fhevm.publicDecrypt([pendingHandle]);
    const clearAmount = BigInt(decryptResult.clearValues[pendingHandle]);
    const proof = decryptResult.decryptionProof;
    await pool.connect(alice).finalizeWithdraw(Number(clearAmount), proof);

    const treasuryBalAfter = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await pool.balanceOf(treasury.address),
      poolAddress,
      treasury
    );
    // fee = max(10_000_000*10/10_000, 10_000) = 10_000
    expect(treasuryBalAfter - treasuryBalBefore).to.equal(10_000n);
  });

  it("should finalize with clearAmount=0 and reset state", async function () {
    const bob = (await ethers.getSigners())[3];
    const input = fhevm.createEncryptedInput(poolAddress, bob.address);
    input.add64(1_000_000n);
    const encrypted = await input.encrypt();

    // Bob has no funds → 0 pending
    await pool.connect(bob).requestWithdraw(encrypted.handles[0], encrypted.inputProof);

    const pendingHandle = await pool.pendingWithdrawOf(bob.address);
    const decryptResult = await fhevm.publicDecrypt([pendingHandle]);
    const clearAmount = BigInt(decryptResult.clearValues[pendingHandle]);
    const proof = decryptResult.decryptionProof;

    // Finalize with 0 — should just reset state, no transfer
    await pool.connect(bob).finalizeWithdraw(Number(clearAmount), proof);
    expect(await pool.withdrawRequested(bob.address)).to.equal(false);
  });
});
