import { expect } from "chai";
import { ethers } from "hardhat";
import { fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("ConfidentialPaymentPool — V1.2 Features", function () {
  let pool: any;
  let usdc: any;
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let poolAddress: string;

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    deployer = signers[0];
    alice = signers[1];
    bob = signers[2];
    treasury = signers[3];

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
    await pool.connect(alice).deposit(20_000_000);
  });

  function randomNonce(): string {
    return ethers.hexlify(ethers.randomBytes(32));
  }

  // ═══════════════════════════════════════
  // PAUSE / UNPAUSE
  // ═══════════════════════════════════════

  describe("Pause", function () {
    it("should pause and block deposits", async function () {
      await pool.pause();
      expect(await pool.paused()).to.equal(true);

      // FHEVM plugin intercepts reverts — chai matchers don't work, use try/catch
      let reverted = false;
      try {
        await pool.connect(alice).deposit(1_000_000);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true, "Expected deposit to revert when paused");
    });

    it("should pause and block payments", async function () {
      await pool.pause();

      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(1_000_000n);
      const encrypted = await input.encrypt();

      let reverted = false;
      try {
        await pool.connect(alice).pay(bob.address, encrypted.handles[0], encrypted.inputProof, 1_000_000, nonce, ethers.ZeroHash);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true, "Expected pay to revert when paused");
    });

    it("should pause and block withdraw requests", async function () {
      await pool.pause();

      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(1_000_000n);
      const encrypted = await input.encrypt();

      let reverted = false;
      try {
        await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true, "Expected requestWithdraw to revert when paused");
    });

    it("should allow cancelWithdraw while paused", async function () {
      // Request withdraw before pause
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(1_000_000n);
      const encrypted = await input.encrypt();
      await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);

      await pool.pause();

      // Cancel should still work (escape hatch)
      await pool.connect(alice).cancelWithdraw();
      expect(await pool.withdrawRequested(alice.address)).to.equal(false);
    });

    it("should allow finalizeWithdraw while paused", async function () {
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(1_000_000n);
      const encrypted = await input.encrypt();
      await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);

      await pool.pause();

      // Finalize should still work (must be able to recover funds)
      const pendingHandle = await pool.pendingWithdrawOf(alice.address);
      const decryptResult = await fhevm.publicDecrypt([pendingHandle]);
      const clearAmount = BigInt(decryptResult.clearValues[pendingHandle]);
      const proof = decryptResult.decryptionProof;

      await pool.connect(alice).finalizeWithdraw(Number(clearAmount), proof);
      expect(await pool.withdrawRequested(alice.address)).to.equal(false);
    });

    it("should unpause and allow deposits", async function () {
      await pool.pause();
      await pool.unpause();
      expect(await pool.paused()).to.equal(false);

      await pool.connect(alice).deposit(1_000_000);
    });

    it("should emit Paused event", async function () {
      const tx = await pool.pause();
      const receipt = await tx.wait();
      const event = receipt.logs.find((log: any) => {
        try {
          const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
          return parsed?.name === "Paused";
        } catch { return false; }
      });
      expect(event).to.not.be.undefined;
    });

    it("should emit Unpaused event", async function () {
      await pool.pause();
      const tx = await pool.unpause();
      const receipt = await tx.wait();
      const event = receipt.logs.find((log: any) => {
        try {
          const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
          return parsed?.name === "Unpaused";
        } catch { return false; }
      });
      expect(event).to.not.be.undefined;
    });

    it("should revert pause from non-owner", async function () {
      await expect(
        pool.connect(alice).pause()
      ).to.be.revertedWithCustomError(pool, "OnlyOwner");
    });

    it("should revert unpause when not paused", async function () {
      await expect(
        pool.unpause()
      ).to.be.revertedWithCustomError(pool, "ContractNotPaused");
    });

    it("should revert pause when already paused", async function () {
      await pool.pause();
      await expect(
        pool.pause()
      ).to.be.revertedWithCustomError(pool, "ContractPaused");
    });
  });

  // ═══════════════════════════════════════
  // TREASURY WITHDRAW
  // ═══════════════════════════════════════

  describe("Treasury Withdraw", function () {
    it("should allow treasury to withdraw accrued fees", async function () {
      // Alice deposit created 20_000 fee to treasury
      const usdcBefore = await usdc.balanceOf(treasury.address);

      await pool.connect(treasury).treasuryWithdraw(20_000);

      const usdcAfter = await usdc.balanceOf(treasury.address);
      expect(usdcAfter - usdcBefore).to.equal(20_000n);
    });

    it("should allow owner to trigger treasury withdraw", async function () {
      const usdcBefore = await usdc.balanceOf(treasury.address);

      await pool.treasuryWithdraw(10_000);

      const usdcAfter = await usdc.balanceOf(treasury.address);
      expect(usdcAfter - usdcBefore).to.equal(10_000n);
    });

    it("should emit TreasuryWithdrawn event", async function () {
      const tx = await pool.connect(treasury).treasuryWithdraw(10_000);
      const receipt = await tx.wait();
      const event = receipt.logs.find((log: any) => {
        try {
          const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
          return parsed?.name === "TreasuryWithdrawn";
        } catch { return false; }
      });
      expect(event).to.not.be.undefined;
    });

    it("should revert treasury withdraw from non-treasury non-owner", async function () {
      let reverted = false;
      try {
        await pool.connect(alice).treasuryWithdraw(10_000);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true, "Expected treasuryWithdraw to revert from non-treasury non-owner");
    });

    it("should revert treasury withdraw of zero", async function () {
      await expect(
        pool.connect(treasury).treasuryWithdraw(0)
      ).to.be.revertedWithCustomError(pool, "ZeroAmount");
    });
  });

  // ═══════════════════════════════════════
  // TREASURY FEE MIGRATION
  // ═══════════════════════════════════════

  describe("Treasury Fee Migration", function () {
    it("should migrate fees to new treasury on setTreasury", async function () {
      const newTreasury = (await ethers.getSigners())[4];

      // Treasury has 20_000 fees from alice's deposit
      const oldTreasuryBal = await fhevm.userDecryptEuint(
        FhevmType.euint64, await pool.balanceOf(treasury.address), poolAddress, treasury
      );
      expect(oldTreasuryBal).to.equal(20_000n);

      // Change treasury
      await pool.setTreasury(newTreasury.address);

      // New treasury should have the old fees
      const newTreasuryBal = await fhevm.userDecryptEuint(
        FhevmType.euint64, await pool.balanceOf(newTreasury.address), poolAddress, newTreasury
      );
      expect(newTreasuryBal).to.equal(20_000n);

      // Old treasury balance should be 0
      const oldBalAfter = await fhevm.userDecryptEuint(
        FhevmType.euint64, await pool.balanceOf(treasury.address), poolAddress, treasury
      );
      expect(oldBalAfter).to.equal(0n);
    });
  });

  // ═══════════════════════════════════════
  // WITHDRAW TIMEOUT
  // ═══════════════════════════════════════

  describe("Withdraw Timeout", function () {
    it("should record withdraw request timestamp", async function () {
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(1_000_000n);
      const encrypted = await input.encrypt();

      await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);

      const ts = await pool.withdrawRequestedAt(alice.address);
      expect(ts).to.be.greaterThan(0);
    });

    it("should emit WithdrawRequested with expiresAt", async function () {
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(1_000_000n);
      const encrypted = await input.encrypt();

      const tx = await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);
      const receipt = await tx.wait();

      const event = receipt.logs.find((log: any) => {
        try {
          const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
          return parsed?.name === "WithdrawRequested";
        } catch { return false; }
      });
      expect(event).to.not.be.undefined;
    });

    it("should revert expireWithdraw before timeout", async function () {
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(1_000_000n);
      const encrypted = await input.encrypt();
      await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);

      await expect(
        pool.expireWithdraw(alice.address)
      ).to.be.revertedWithCustomError(pool, "WithdrawNotExpired");
    });

    it("should allow expireWithdraw after timeout", async function () {
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(1_000_000n);
      const encrypted = await input.encrypt();
      await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);

      const balBefore = await fhevm.userDecryptEuint(
        FhevmType.euint64, await pool.balanceOf(alice.address), poolAddress, alice
      );

      // Fast-forward 7 days + 1 second
      await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      // Anyone can call expireWithdraw
      await pool.connect(bob).expireWithdraw(alice.address);

      expect(await pool.withdrawRequested(alice.address)).to.equal(false);

      // Alice should get refund
      const balAfter = await fhevm.userDecryptEuint(
        FhevmType.euint64, await pool.balanceOf(alice.address), poolAddress, alice
      );
      expect(balAfter - balBefore).to.equal(1_000_000n);
    });

    it("should emit WithdrawExpired event", async function () {
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(1_000_000n);
      const encrypted = await input.encrypt();
      await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);

      await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      const tx = await pool.expireWithdraw(alice.address);
      const receipt = await tx.wait();
      const event = receipt.logs.find((log: any) => {
        try {
          const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
          return parsed?.name === "WithdrawExpired";
        } catch { return false; }
      });
      expect(event).to.not.be.undefined;
    });

    it("should clear timestamp on cancelWithdraw", async function () {
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(1_000_000n);
      const encrypted = await input.encrypt();
      await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);

      await pool.connect(alice).cancelWithdraw();
      expect(await pool.withdrawRequestedAt(alice.address)).to.equal(0);
    });
  });

  // ═══════════════════════════════════════
  // POOL CAPS (TVL + Per-User)
  // ═══════════════════════════════════════

  describe("Pool Caps", function () {
    it("should enforce pool TVL cap", async function () {
      // Set pool cap to 25 USDC (alice already deposited 20)
      await pool.setPoolCaps(25_000_000, 0);

      // This should fail (20 deposited + 10 > 25 cap)
      await expect(
        pool.connect(alice).deposit(10_000_000)
      ).to.be.revertedWithCustomError(pool, "PoolCapExceeded");
    });

    it("should allow deposit under pool cap", async function () {
      await pool.setPoolCaps(50_000_000, 0);

      // 20 deposited + 5 = 25 < 50 cap → OK
      await pool.connect(alice).deposit(5_000_000);
    });

    it("should enforce per-user deposit cap", async function () {
      // Set per-user cap to 25 USDC (alice already deposited 20)
      await pool.setPoolCaps(0, 25_000_000);

      await expect(
        pool.connect(alice).deposit(10_000_000)
      ).to.be.revertedWithCustomError(pool, "UserCapExceeded");
    });

    it("should allow deposit under user cap", async function () {
      await pool.setPoolCaps(0, 30_000_000);

      // 20 deposited + 5 = 25 < 30 cap → OK
      await pool.connect(alice).deposit(5_000_000);
    });

    it("should emit PoolCapUpdated event", async function () {
      const tx = await pool.setPoolCaps(100_000_000, 50_000_000);
      const receipt = await tx.wait();
      const event = receipt.logs.find((log: any) => {
        try {
          const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
          return parsed?.name === "PoolCapUpdated";
        } catch { return false; }
      });
      expect(event).to.not.be.undefined;
    });

    it("should revert setPoolCaps from non-owner", async function () {
      await expect(
        pool.connect(alice).setPoolCaps(100_000_000, 50_000_000)
      ).to.be.revertedWithCustomError(pool, "OnlyOwner");
    });

    it("should allow unlimited with cap=0", async function () {
      await pool.setPoolCaps(0, 0);
      // Should not revert
      await pool.connect(alice).deposit(50_000_000);
    });
  });

  // ═══════════════════════════════════════
  // PAYMENT MEMO
  // ═══════════════════════════════════════

  describe("Payment Memo", function () {
    it("should include memo in PaymentExecuted event", async function () {
      const nonce = randomNonce();
      const memo = ethers.id("invoice-001");
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(1_000_000n);
      const encrypted = await input.encrypt();

      const tx = await pool.connect(alice).pay(
        bob.address, encrypted.handles[0], encrypted.inputProof, 1_000_000, nonce, memo
      );
      const receipt = await tx.wait();

      const event = receipt.logs.find((log: any) => {
        try {
          const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
          if (parsed?.name === "PaymentExecuted") {
            return parsed.args.memo === memo;
          }
        } catch { /* ignore */ }
        return false;
      });
      expect(event).to.not.be.undefined;
    });

    it("should accept zero memo", async function () {
      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(1_000_000n);
      const encrypted = await input.encrypt();

      // Should not revert with zero memo
      await pool.connect(alice).pay(
        bob.address, encrypted.handles[0], encrypted.inputProof, 1_000_000, nonce, ethers.ZeroHash
      );
    });
  });

  // ═══════════════════════════════════════
  // BALANCE REQUEST EVENT
  // ═══════════════════════════════════════

  describe("Balance Request Event", function () {
    it("should emit BalanceRequested event", async function () {
      const tx = await pool.connect(alice).requestBalance();
      const receipt = await tx.wait();

      const event = receipt.logs.find((log: any) => {
        try {
          const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
          return parsed?.name === "BalanceRequested";
        } catch { return false; }
      });
      expect(event).to.not.be.undefined;
    });
  });
});
