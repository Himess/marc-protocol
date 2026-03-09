import { expect } from "chai";
import { ethers } from "hardhat";
import { fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("ConfidentialPaymentPool — Edge Cases", function () {
  let pool: any;
  let usdc: any;
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let charlie: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let poolAddress: string;

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    deployer = signers[0];
    alice = signers[1];
    bob = signers[2];
    charlie = signers[3];
    treasury = signers[4];

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    const Pool = await ethers.getContractFactory("ConfidentialPaymentPool");
    pool = await Pool.deploy(await usdc.getAddress(), treasury.address);
    await pool.waitForDeployment();
    poolAddress = await pool.getAddress();
  });

  function randomNonce(): string {
    return ethers.hexlify(ethers.randomBytes(32));
  }

  describe("Constructor", function () {
    it("should revert with zero USDC address", async function () {
      const Pool = await ethers.getContractFactory("ConfidentialPaymentPool");
      await expect(
        Pool.deploy(ethers.ZeroAddress, treasury.address)
      ).to.be.revertedWithCustomError(pool, "ZeroAddress");
    });

    it("should revert with zero treasury address", async function () {
      const Pool = await ethers.getContractFactory("ConfidentialPaymentPool");
      await expect(
        Pool.deploy(await usdc.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(pool, "ZeroAddress");
    });

    it("should set owner to deployer", async function () {
      expect(await pool.owner()).to.equal(deployer.address);
    });

    it("should set correct USDC address", async function () {
      expect(await pool.usdc()).to.equal(await usdc.getAddress());
    });

    it("should set correct treasury", async function () {
      expect(await pool.treasury()).to.equal(treasury.address);
    });

    it("should initialize pendingOwner to zero", async function () {
      expect(await pool.pendingOwner()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("Admin — setTreasury", function () {
    it("should allow owner to update treasury", async function () {
      await pool.connect(deployer).setTreasury(charlie.address);
      expect(await pool.treasury()).to.equal(charlie.address);
    });

    it("should emit TreasuryUpdated event", async function () {
      const tx = await pool.connect(deployer).setTreasury(charlie.address);
      const receipt = await tx.wait();

      const event = receipt.logs.find((log: any) => {
        try {
          const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
          return parsed?.name === "TreasuryUpdated";
        } catch {
          return false;
        }
      });
      expect(event).to.not.be.undefined;
    });

    it("should revert non-owner treasury update", async function () {
      let reverted = false;
      try {
        await pool.connect(alice).setTreasury(charlie.address);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("should revert treasury update to zero address", async function () {
      await expect(
        pool.connect(deployer).setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(pool, "ZeroAddress");
    });
  });

  describe("Admin — transferOwnership (2-step)", function () {
    it("should start ownership transfer", async function () {
      await pool.connect(deployer).transferOwnership(alice.address);
      expect(await pool.pendingOwner()).to.equal(alice.address);
      // Owner should NOT change yet
      expect(await pool.owner()).to.equal(deployer.address);
    });

    it("should emit OwnershipTransferStarted event", async function () {
      const tx = await pool.connect(deployer).transferOwnership(alice.address);
      const receipt = await tx.wait();

      const event = receipt.logs.find((log: any) => {
        try {
          const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
          return parsed?.name === "OwnershipTransferStarted";
        } catch {
          return false;
        }
      });
      expect(event).to.not.be.undefined;
    });

    it("should accept ownership transfer", async function () {
      await pool.connect(deployer).transferOwnership(alice.address);
      await pool.connect(alice).acceptOwnership();

      expect(await pool.owner()).to.equal(alice.address);
      expect(await pool.pendingOwner()).to.equal(ethers.ZeroAddress);
    });

    it("should emit OwnershipTransferred event on accept", async function () {
      await pool.connect(deployer).transferOwnership(alice.address);
      const tx = await pool.connect(alice).acceptOwnership();
      const receipt = await tx.wait();

      const event = receipt.logs.find((log: any) => {
        try {
          const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
          return parsed?.name === "OwnershipTransferred";
        } catch {
          return false;
        }
      });
      expect(event).to.not.be.undefined;
    });

    it("should revert non-owner transferOwnership", async function () {
      let reverted = false;
      try {
        await pool.connect(alice).transferOwnership(bob.address);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("should revert transferOwnership to zero address", async function () {
      await expect(
        pool.connect(deployer).transferOwnership(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(pool, "ZeroAddress");
    });

    it("should revert acceptOwnership from non-pending", async function () {
      await pool.connect(deployer).transferOwnership(alice.address);
      let reverted = false;
      try {
        await pool.connect(bob).acceptOwnership();
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("should allow new owner to setTreasury after transfer", async function () {
      await pool.connect(deployer).transferOwnership(alice.address);
      await pool.connect(alice).acceptOwnership();

      await pool.connect(alice).setTreasury(bob.address);
      expect(await pool.treasury()).to.equal(bob.address);
    });

    it("should prevent old owner from setTreasury after transfer", async function () {
      await pool.connect(deployer).transferOwnership(alice.address);
      await pool.connect(alice).acceptOwnership();

      let reverted = false;
      try {
        await pool.connect(deployer).setTreasury(charlie.address);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });
  });

  describe("Multi-user flows", function () {
    beforeEach(async function () {
      // Fund alice and bob
      await usdc.mint(alice.address, 100_000_000n);
      await usdc.mint(bob.address, 100_000_000n);
      await usdc.connect(alice).approve(poolAddress, 100_000_000n);
      await usdc.connect(bob).approve(poolAddress, 100_000_000n);
    });

    it("should handle deposits from multiple users", async function () {
      await pool.connect(alice).deposit(10_000_000);
      await pool.connect(bob).deposit(20_000_000);

      const aliceEnc = await pool.balanceOf(alice.address);
      const aliceBal = await fhevm.userDecryptEuint(FhevmType.euint64, aliceEnc, poolAddress, alice);
      expect(aliceBal).to.equal(9_990_000n);

      const bobEnc = await pool.balanceOf(bob.address);
      const bobBal = await fhevm.userDecryptEuint(FhevmType.euint64, bobEnc, poolAddress, bob);
      // 20_000_000 - fee. fee = max(20_000_000*10/10_000, 10_000) = max(20_000, 10_000) = 20_000
      expect(bobBal).to.equal(19_980_000n);
    });

    it("should handle bidirectional payments", async function () {
      await pool.connect(alice).deposit(20_000_000);
      await pool.connect(bob).deposit(20_000_000);

      // Alice pays Bob
      const nonce1 = randomNonce();
      const input1 = fhevm.createEncryptedInput(poolAddress, alice.address);
      input1.add64(5_000_000n);
      const enc1 = await input1.encrypt();
      await pool.connect(alice).pay(bob.address, enc1.handles[0], enc1.inputProof, 5_000_000, nonce1, ethers.ZeroHash);

      // Bob pays Alice
      const nonce2 = randomNonce();
      const input2 = fhevm.createEncryptedInput(poolAddress, bob.address);
      input2.add64(3_000_000n);
      const enc2 = await input2.encrypt();
      await pool.connect(bob).pay(alice.address, enc2.handles[0], enc2.inputProof, 3_000_000, nonce2, ethers.ZeroHash);

      const aliceEnc = await pool.balanceOf(alice.address);
      const aliceBal = await fhevm.userDecryptEuint(FhevmType.euint64, aliceEnc, poolAddress, alice);
      // Alice: 19_980_000 - 5_000_000 + (3_000_000 - 10_000) = 17_970_000
      expect(aliceBal).to.equal(17_970_000n);
    });

    it("should handle deposit → pay → receive → check balance", async function () {
      await pool.connect(alice).deposit(10_000_000); // net 9_990_000
      await pool.connect(bob).deposit(10_000_000);   // net 9_990_000

      // Alice pays Bob
      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(2_000_000n);
      const encrypted = await input.encrypt();
      await pool.connect(alice).pay(bob.address, encrypted.handles[0], encrypted.inputProof, 2_000_000, nonce, ethers.ZeroHash);

      // Alice: 9_990_000 - 2_000_000 = 7_990_000
      const aliceEnc = await pool.balanceOf(alice.address);
      const aliceBal = await fhevm.userDecryptEuint(FhevmType.euint64, aliceEnc, poolAddress, alice);
      expect(aliceBal).to.equal(7_990_000n);

      // Bob: 9_990_000 + (2_000_000 - 10_000) = 11_980_000
      const bobEnc = await pool.balanceOf(bob.address);
      const bobBal = await fhevm.userDecryptEuint(FhevmType.euint64, bobEnc, poolAddress, bob);
      expect(bobBal).to.equal(11_980_000n);
    });
  });

  describe("Balance query (snapshot)", function () {
    it("should create balance snapshot on request", async function () {
      await usdc.mint(alice.address, 10_000_000n);
      await usdc.connect(alice).approve(poolAddress, 10_000_000n);
      await pool.connect(alice).deposit(10_000_000);

      await pool.connect(alice).requestBalance();
      expect(await pool.balanceQueryRequested(alice.address)).to.equal(true);

      // Snapshot should exist
      const snapshot = await pool.balanceSnapshotOf(alice.address);
      expect(snapshot).to.not.equal(0n);
    });

    it("should not modify live balance on requestBalance", async function () {
      await usdc.mint(alice.address, 10_000_000n);
      await usdc.connect(alice).approve(poolAddress, 10_000_000n);
      await pool.connect(alice).deposit(10_000_000);

      const balBefore = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(alice.address),
        poolAddress,
        alice
      );

      await pool.connect(alice).requestBalance();

      const balAfter = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(alice.address),
        poolAddress,
        alice
      );
      expect(balAfter).to.equal(balBefore);
    });

    it("should handle balance query for uninitialized user", async function () {
      // Should not revert, just return
      await pool.connect(alice).requestBalance();
      expect(await pool.balanceQueryRequested(alice.address)).to.equal(false);
    });
  });

  describe("Payment to self", function () {
    it("should handle self-payment", async function () {
      await usdc.mint(alice.address, 50_000_000n);
      await usdc.connect(alice).approve(poolAddress, 50_000_000n);
      await pool.connect(alice).deposit(20_000_000); // net 19_980_000

      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(5_000_000n);
      const encrypted = await input.encrypt();

      // Alice pays herself — should succeed, lose only the fee
      await pool.connect(alice).pay(alice.address, encrypted.handles[0], encrypted.inputProof, 5_000_000, nonce, ethers.ZeroHash);

      const aliceEnc = await pool.balanceOf(alice.address);
      const aliceBal = await fhevm.userDecryptEuint(FhevmType.euint64, aliceEnc, poolAddress, alice);
      // 19_980_000 - 5_000_000 + (5_000_000 - 10_000) = 19_970_000
      expect(aliceBal).to.equal(19_970_000n);
    });
  });
});
