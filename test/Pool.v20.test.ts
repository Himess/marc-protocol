import { expect } from "chai";
import { ethers } from "hardhat";
import { fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("ConfidentialPaymentPool — V2.0 Features", function () {
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

    // Fund alice with 100 USDC
    await usdc.mint(alice.address, 100_000_000n);
    await usdc.connect(alice).approve(poolAddress, 100_000_000n);
    await pool.connect(alice).deposit(50_000_000); // ~49_950_000 net
  });

  function randomNonce(): string {
    return ethers.hexlify(ethers.randomBytes(32));
  }

  // ═══════════════════════════════════════
  // EncryptedErrors (6 tests)
  // ═══════════════════════════════════════

  describe("EncryptedErrors", function () {
    it("should record lastPayError = 1 on insufficient balance", async function () {
      // Alice has ~49_950_000; try to pay 60_000_000 (more than balance)
      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(60_000_000n);
      const encrypted = await input.encrypt();

      await pool.connect(alice).pay(
        bob.address,
        encrypted.handles[0],
        encrypted.inputProof,
        60_000_000, // minPrice = amount, so meetsPrice = true
        nonce,
        ethers.ZeroHash
      );

      const errHandle = await pool.lastPayError(alice.address);
      const errVal = await fhevm.userDecryptEuint(FhevmType.euint8, errHandle, poolAddress, alice);
      expect(errVal).to.equal(1n); // insufficient funds
    });

    it("should record lastPayError = 2 on amount < minPrice", async function () {
      // Encrypt 500_000 (0.5 USDC) but set minPrice = 1_000_000 (1 USDC)
      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(500_000n);
      const encrypted = await input.encrypt();

      await pool.connect(alice).pay(
        bob.address,
        encrypted.handles[0],
        encrypted.inputProof,
        1_000_000, // minPrice > encrypted amount
        nonce,
        ethers.ZeroHash
      );

      const errHandle = await pool.lastPayError(alice.address);
      const errVal = await fhevm.userDecryptEuint(FhevmType.euint8, errHandle, poolAddress, alice);
      expect(errVal).to.equal(2n); // below min price
    });

    it("should record lastPayError = 3 on both conditions", async function () {
      // Bob has no balance, encrypt 500_000 but minPrice = 1_000_000
      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, bob.address);
      input.add64(500_000n);
      const encrypted = await input.encrypt();

      await pool.connect(bob).pay(
        alice.address,
        encrypted.handles[0],
        encrypted.inputProof,
        1_000_000,
        nonce,
        ethers.ZeroHash
      );

      const errHandle = await pool.lastPayError(bob.address);
      const errVal = await fhevm.userDecryptEuint(FhevmType.euint8, errHandle, poolAddress, bob);
      expect(errVal).to.equal(3n); // both: 1 | 2 = 3
    });

    it("should record lastPayError = 0 on successful pay", async function () {
      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(1_000_000n);
      const encrypted = await input.encrypt();

      await pool.connect(alice).pay(
        bob.address,
        encrypted.handles[0],
        encrypted.inputProof,
        1_000_000,
        nonce,
        ethers.ZeroHash
      );

      const errHandle = await pool.lastPayError(alice.address);
      const errVal = await fhevm.userDecryptEuint(FhevmType.euint8, errHandle, poolAddress, alice);
      expect(errVal).to.equal(0n);
    });

    it("should make error decryptable by user", async function () {
      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(1_000_000n);
      const encrypted = await input.encrypt();

      await pool.connect(alice).pay(
        bob.address,
        encrypted.handles[0],
        encrypted.inputProof,
        1_000_000,
        nonce,
        ethers.ZeroHash
      );

      // Should not throw — alice has decrypt permission
      const errHandle = await pool.lastPayError(alice.address);
      const errVal = await fhevm.userDecryptEuint(FhevmType.euint8, errHandle, poolAddress, alice);
      expect(typeof errVal).to.equal("bigint");
    });

    it("should update error on each pay call", async function () {
      // First: successful pay
      const nonce1 = randomNonce();
      const input1 = fhevm.createEncryptedInput(poolAddress, alice.address);
      input1.add64(1_000_000n);
      const enc1 = await input1.encrypt();
      await pool.connect(alice).pay(bob.address, enc1.handles[0], enc1.inputProof, 1_000_000, nonce1, ethers.ZeroHash);

      const err1 = await fhevm.userDecryptEuint(FhevmType.euint8, await pool.lastPayError(alice.address), poolAddress, alice);
      expect(err1).to.equal(0n);

      // Second: insufficient funds (try 100M which exceeds balance)
      const nonce2 = randomNonce();
      const input2 = fhevm.createEncryptedInput(poolAddress, alice.address);
      input2.add64(100_000_000n);
      const enc2 = await input2.encrypt();
      await pool.connect(alice).pay(bob.address, enc2.handles[0], enc2.inputProof, 100_000_000, nonce2, ethers.ZeroHash);

      const err2 = await fhevm.userDecryptEuint(FhevmType.euint8, await pool.lastPayError(alice.address), poolAddress, alice);
      expect(err2).to.equal(1n);
    });
  });

  // ═══════════════════════════════════════
  // Confidential Payment Routing (7 tests)
  // ═══════════════════════════════════════

  describe("Confidential Payment Routing", function () {
    it("should create a confidential payment with event", async function () {
      const nonce = randomNonce();

      const addrInput = fhevm.createEncryptedInput(poolAddress, alice.address);
      addrInput.addAddress(bob.address);
      const addrEnc = await addrInput.encrypt();

      const amtInput = fhevm.createEncryptedInput(poolAddress, alice.address);
      amtInput.add64(1_000_000n);
      const amtEnc = await amtInput.encrypt();

      const tx = await pool.connect(alice).payConfidential(
        addrEnc.handles[0],
        addrEnc.inputProof,
        amtEnc.handles[0],
        amtEnc.inputProof,
        1_000_000,
        nonce,
        ethers.ZeroHash
      );
      const receipt = await tx.wait();

      const event = receipt.logs.find((log: any) => {
        try {
          const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
          return parsed?.name === "ConfidentialPaymentCreated";
        } catch {
          return false;
        }
      });
      expect(event).to.not.be.undefined;
      expect(await pool.confidentialPaymentCount()).to.equal(1n);
    });

    it("should claim payment with correct address", async function () {
      // Create confidential payment
      const nonce = randomNonce();
      const addrInput = fhevm.createEncryptedInput(poolAddress, alice.address);
      addrInput.addAddress(bob.address);
      const addrEnc = await addrInput.encrypt();

      const amtInput = fhevm.createEncryptedInput(poolAddress, alice.address);
      amtInput.add64(1_000_000n);
      const amtEnc = await amtInput.encrypt();

      await pool.connect(alice).payConfidential(
        addrEnc.handles[0], addrEnc.inputProof,
        amtEnc.handles[0], amtEnc.inputProof,
        1_000_000, nonce, ethers.ZeroHash
      );

      // Bob claims with his address
      const claimInput = fhevm.createEncryptedInput(poolAddress, bob.address);
      claimInput.addAddress(bob.address);
      const claimEnc = await claimInput.encrypt();

      await pool.connect(bob).claimPayment(0, claimEnc.handles[0], claimEnc.inputProof);

      // Bob should have received funds
      const bobBal = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(bob.address),
        poolAddress,
        bob
      );
      // net = 1_000_000 - max(1_000_000*10/10_000, 10_000) = 1_000_000 - 10_000 = 990_000
      expect(bobBal).to.equal(990_000n);
    });

    it("should credit 0 on claim with wrong address (silent fail)", async function () {
      const nonce = randomNonce();
      const addrInput = fhevm.createEncryptedInput(poolAddress, alice.address);
      addrInput.addAddress(bob.address);
      const addrEnc = await addrInput.encrypt();

      const amtInput = fhevm.createEncryptedInput(poolAddress, alice.address);
      amtInput.add64(1_000_000n);
      const amtEnc = await amtInput.encrypt();

      await pool.connect(alice).payConfidential(
        addrEnc.handles[0], addrEnc.inputProof,
        amtEnc.handles[0], amtEnc.inputProof,
        1_000_000, nonce, ethers.ZeroHash
      );

      // Charlie (signers[4]) claims instead of Bob — wrong address
      const charlie = (await ethers.getSigners())[4];
      const claimInput = fhevm.createEncryptedInput(poolAddress, charlie.address);
      claimInput.addAddress(charlie.address);
      const claimEnc = await claimInput.encrypt();

      await pool.connect(charlie).claimPayment(0, claimEnc.handles[0], claimEnc.inputProof);

      // Charlie should have 0 (silent fail)
      const charlieBal = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(charlie.address),
        poolAddress,
        charlie
      );
      expect(charlieBal).to.equal(0n);
    });

    it("should revert on double-claim", async function () {
      const nonce = randomNonce();
      const addrInput = fhevm.createEncryptedInput(poolAddress, alice.address);
      addrInput.addAddress(bob.address);
      const addrEnc = await addrInput.encrypt();

      const amtInput = fhevm.createEncryptedInput(poolAddress, alice.address);
      amtInput.add64(1_000_000n);
      const amtEnc = await amtInput.encrypt();

      await pool.connect(alice).payConfidential(
        addrEnc.handles[0], addrEnc.inputProof,
        amtEnc.handles[0], amtEnc.inputProof,
        1_000_000, nonce, ethers.ZeroHash
      );

      // First claim
      const claimInput1 = fhevm.createEncryptedInput(poolAddress, bob.address);
      claimInput1.addAddress(bob.address);
      const claimEnc1 = await claimInput1.encrypt();
      await pool.connect(bob).claimPayment(0, claimEnc1.handles[0], claimEnc1.inputProof);

      // Second claim should revert
      const claimInput2 = fhevm.createEncryptedInput(poolAddress, bob.address);
      claimInput2.addAddress(bob.address);
      const claimEnc2 = await claimInput2.encrypt();
      await expect(
        pool.connect(bob).claimPayment(0, claimEnc2.handles[0], claimEnc2.inputProof)
      ).to.be.revertedWithCustomError(pool, "PaymentAlreadyClaimed");
    });

    it("should emit ConfidentialPaymentCreated event", async function () {
      const nonce = randomNonce();
      const addrInput = fhevm.createEncryptedInput(poolAddress, alice.address);
      addrInput.addAddress(bob.address);
      const addrEnc = await addrInput.encrypt();

      const amtInput = fhevm.createEncryptedInput(poolAddress, alice.address);
      amtInput.add64(2_000_000n);
      const amtEnc = await amtInput.encrypt();

      const tx = await pool.connect(alice).payConfidential(
        addrEnc.handles[0], addrEnc.inputProof,
        amtEnc.handles[0], amtEnc.inputProof,
        2_000_000, nonce, ethers.ZeroHash
      );
      const receipt = await tx.wait();

      const event = receipt.logs.find((log: any) => {
        try {
          const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
          return parsed?.name === "ConfidentialPaymentCreated";
        } catch {
          return false;
        }
      });
      expect(event).to.not.be.undefined;

      const parsed = pool.interface.parseLog({ topics: event.topics, data: event.data });
      expect(parsed.args[0]).to.equal(0n); // paymentId
      expect(parsed.args[1]).to.equal(alice.address); // sender
    });

    it("should emit ConfidentialPaymentClaimed event", async function () {
      const nonce = randomNonce();
      const addrInput = fhevm.createEncryptedInput(poolAddress, alice.address);
      addrInput.addAddress(bob.address);
      const addrEnc = await addrInput.encrypt();

      const amtInput = fhevm.createEncryptedInput(poolAddress, alice.address);
      amtInput.add64(1_000_000n);
      const amtEnc = await amtInput.encrypt();

      await pool.connect(alice).payConfidential(
        addrEnc.handles[0], addrEnc.inputProof,
        amtEnc.handles[0], amtEnc.inputProof,
        1_000_000, nonce, ethers.ZeroHash
      );

      const claimInput = fhevm.createEncryptedInput(poolAddress, bob.address);
      claimInput.addAddress(bob.address);
      const claimEnc = await claimInput.encrypt();

      const tx = await pool.connect(bob).claimPayment(0, claimEnc.handles[0], claimEnc.inputProof);
      const receipt = await tx.wait();

      const event = receipt.logs.find((log: any) => {
        try {
          const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
          return parsed?.name === "ConfidentialPaymentClaimed";
        } catch {
          return false;
        }
      });
      expect(event).to.not.be.undefined;
    });

    it("should deduct sender balance on confidential payment", async function () {
      const balBefore = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(alice.address),
        poolAddress,
        alice
      );

      const nonce = randomNonce();
      const addrInput = fhevm.createEncryptedInput(poolAddress, alice.address);
      addrInput.addAddress(bob.address);
      const addrEnc = await addrInput.encrypt();

      const amtInput = fhevm.createEncryptedInput(poolAddress, alice.address);
      amtInput.add64(5_000_000n);
      const amtEnc = await amtInput.encrypt();

      await pool.connect(alice).payConfidential(
        addrEnc.handles[0], addrEnc.inputProof,
        amtEnc.handles[0], amtEnc.inputProof,
        5_000_000, nonce, ethers.ZeroHash
      );

      const balAfter = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(alice.address),
        poolAddress,
        alice
      );

      // Should deduct 5_000_000 from balance
      expect(balBefore - balAfter).to.equal(5_000_000n);
    });
  });

  // ═══════════════════════════════════════
  // Encrypted Fee (4 tests)
  // ═══════════════════════════════════════

  describe("Encrypted Fee", function () {
    it("should apply min fee for small amounts", async function () {
      const treasuryBalBefore = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(treasury.address),
        poolAddress,
        treasury
      );

      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(1_000_000n); // 1 USDC — fee = max(1000, 10000) = 10_000
      const encrypted = await input.encrypt();

      await pool.connect(alice).pay(
        bob.address, encrypted.handles[0], encrypted.inputProof,
        1_000_000, nonce, ethers.ZeroHash
      );

      const treasuryBalAfter = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(treasury.address),
        poolAddress,
        treasury
      );

      // min fee = 10_000 (0.01 USDC)
      expect(treasuryBalAfter - treasuryBalBefore).to.equal(10_000n);
    });

    it("should apply percentage fee for large amounts", async function () {
      const treasuryBalBefore = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(treasury.address),
        poolAddress,
        treasury
      );

      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(20_000_000n); // 20 USDC — fee = max(20_000, 10_000) = 20_000
      const encrypted = await input.encrypt();

      await pool.connect(alice).pay(
        bob.address, encrypted.handles[0], encrypted.inputProof,
        20_000_000, nonce, ethers.ZeroHash
      );

      const treasuryBalAfter = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(treasury.address),
        poolAddress,
        treasury
      );

      // 20_000_000 * 10 / 10_000 = 20_000
      expect(treasuryBalAfter - treasuryBalBefore).to.equal(20_000n);
    });

    it("should credit treasury correct fee amount", async function () {
      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(5_000_000n);
      const encrypted = await input.encrypt();

      await pool.connect(alice).pay(
        bob.address, encrypted.handles[0], encrypted.inputProof,
        5_000_000, nonce, ethers.ZeroHash
      );

      // fee = max(5_000_000 * 10 / 10_000, 10_000) = max(5_000, 10_000) = 10_000
      // bob receives 5_000_000 - 10_000 = 4_990_000
      const bobBal = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(bob.address),
        poolAddress,
        bob
      );
      expect(bobBal).to.equal(4_990_000n);
    });

    it("should match V1.2 results for same amounts", async function () {
      // Test with 10 USDC — fee should be max(10_000, 10_000) = 10_000
      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(10_000_000n);
      const encrypted = await input.encrypt();

      await pool.connect(alice).pay(
        bob.address, encrypted.handles[0], encrypted.inputProof,
        10_000_000, nonce, ethers.ZeroHash
      );

      const bobBal = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(bob.address),
        poolAddress,
        bob
      );
      // V1.2: fee = _calculateFee(10_000_000) = max(10_000, 10_000) = 10_000
      // V2.0 encrypted fee: max(10_000_000*10/10_000, 10_000) = max(10_000, 10_000) = 10_000
      // Same result: 10_000_000 - 10_000 = 9_990_000
      expect(bobBal).to.equal(9_990_000n);
    });
  });

  // ═══════════════════════════════════════
  // FHE.min in Withdraw (3 tests)
  // ═══════════════════════════════════════

  describe("FHE.min in Withdraw", function () {
    it("should cap withdraw to balance when amount exceeds balance", async function () {
      // Alice has ~49_950_000 net
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(100_000_000n); // More than balance
      const encrypted = await input.encrypt();

      await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);

      // Balance should be 0 (FHE.min capped to balance, all withdrawn)
      const balAfter = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(alice.address),
        poolAddress,
        alice
      );
      expect(balAfter).to.equal(0n);

      // Pending withdraw should be the full balance
      const pendingHandle = await pool.pendingWithdrawOf(alice.address);
      const decryptResult = await fhevm.publicDecrypt([pendingHandle]);
      const clearPending = BigInt(decryptResult.clearValues[pendingHandle]);
      expect(clearPending).to.equal(49_950_000n);
    });

    it("should withdraw exact balance and leave 0 remainder", async function () {
      const balBefore = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(alice.address),
        poolAddress,
        alice
      );

      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(balBefore);
      const encrypted = await input.encrypt();

      await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);

      const balAfter = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(alice.address),
        poolAddress,
        alice
      );
      expect(balAfter).to.equal(0n);
    });

    it("should withdraw partial and leave correct remainder", async function () {
      const balBefore = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(alice.address),
        poolAddress,
        alice
      );

      const withdrawAmt = 10_000_000n;
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(withdrawAmt);
      const encrypted = await input.encrypt();

      await pool.connect(alice).requestWithdraw(encrypted.handles[0], encrypted.inputProof);

      const balAfter = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(alice.address),
        poolAddress,
        alice
      );
      expect(balAfter).to.equal(balBefore - withdrawAmt);
    });
  });

  // ═══════════════════════════════════════
  // Payment Counter (4 tests)
  // ═══════════════════════════════════════

  describe("Payment Counter", function () {
    it("should return 0 for new user", async function () {
      // Bob has never paid
      const countHandle = await pool.paymentCountOf(bob.address);
      // Not initialized, handle should be 0
      expect(countHandle).to.equal(0n);
    });

    it("should increment to 1 after first successful pay", async function () {
      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(1_000_000n);
      const encrypted = await input.encrypt();

      await pool.connect(alice).pay(
        bob.address, encrypted.handles[0], encrypted.inputProof,
        1_000_000, nonce, ethers.ZeroHash
      );

      const countHandle = await pool.paymentCountOf(alice.address);
      const count = await fhevm.userDecryptEuint(FhevmType.euint32, countHandle, poolAddress, alice);
      expect(count).to.equal(1n);
    });

    it("should increment to 3 after three successful pays", async function () {
      for (let i = 0; i < 3; i++) {
        const nonce = randomNonce();
        const input = fhevm.createEncryptedInput(poolAddress, alice.address);
        input.add64(1_000_000n);
        const encrypted = await input.encrypt();

        await pool.connect(alice).pay(
          bob.address, encrypted.handles[0], encrypted.inputProof,
          1_000_000, nonce, ethers.ZeroHash
        );
      }

      const countHandle = await pool.paymentCountOf(alice.address);
      const count = await fhevm.userDecryptEuint(FhevmType.euint32, countHandle, poolAddress, alice);
      expect(count).to.equal(3n);
    });

    it("should NOT increment counter on silent failure", async function () {
      // First: successful pay to initialize counter
      const nonce1 = randomNonce();
      const input1 = fhevm.createEncryptedInput(poolAddress, alice.address);
      input1.add64(1_000_000n);
      const enc1 = await input1.encrypt();
      await pool.connect(alice).pay(bob.address, enc1.handles[0], enc1.inputProof, 1_000_000, nonce1, ethers.ZeroHash);

      // Second: failed pay (insufficient funds — try 100M)
      const nonce2 = randomNonce();
      const input2 = fhevm.createEncryptedInput(poolAddress, alice.address);
      input2.add64(100_000_000n);
      const enc2 = await input2.encrypt();
      await pool.connect(alice).pay(bob.address, enc2.handles[0], enc2.inputProof, 100_000_000, nonce2, ethers.ZeroHash);

      // Counter should still be 1 (failed pay added 0)
      const countHandle = await pool.paymentCountOf(alice.address);
      const count = await fhevm.userDecryptEuint(FhevmType.euint32, countHandle, poolAddress, alice);
      expect(count).to.equal(1n);
    });
  });

  // ═══════════════════════════════════════
  // Spending Limit — FHE.gt + FHE.not (4 tests)
  // ═══════════════════════════════════════

  describe("Spending Limit (FHE.gt, FHE.not)", function () {
    it("should allow pay within spending limit", async function () {
      // Set spending limit to 5 USDC
      const limitInput = fhevm.createEncryptedInput(poolAddress, alice.address);
      limitInput.add64(5_000_000n);
      const limitEnc = await limitInput.encrypt();
      await pool.connect(alice).setSpendingLimit(limitEnc.handles[0], limitEnc.inputProof);

      // Pay 1 USDC — within limit
      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(1_000_000n);
      const encrypted = await input.encrypt();

      await pool.connect(alice).pay(
        bob.address, encrypted.handles[0], encrypted.inputProof,
        1_000_000, nonce, ethers.ZeroHash
      );

      // Error code should be 0 (successful)
      const errHandle = await pool.lastPayError(alice.address);
      const errVal = await fhevm.userDecryptEuint(FhevmType.euint8, errHandle, poolAddress, alice);
      expect(errVal).to.equal(0n);

      // Bob should have received funds
      const bobBal = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(bob.address),
        poolAddress,
        bob
      );
      expect(bobBal).to.be.greaterThan(0n);
    });

    it("should block pay over daily spending limit with error code 4", async function () {
      // Set spending limit to 1 USDC
      const limitInput = fhevm.createEncryptedInput(poolAddress, alice.address);
      limitInput.add64(1_000_000n);
      const limitEnc = await limitInput.encrypt();
      await pool.connect(alice).setSpendingLimit(limitEnc.handles[0], limitEnc.inputProof);

      // Pay 5 USDC — over limit
      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(5_000_000n);
      const encrypted = await input.encrypt();

      await pool.connect(alice).pay(
        bob.address, encrypted.handles[0], encrypted.inputProof,
        5_000_000, nonce, ethers.ZeroHash
      );

      // Error code should have bit 2 set (4 = over limit)
      const errHandle = await pool.lastPayError(alice.address);
      const errVal = await fhevm.userDecryptEuint(FhevmType.euint8, errHandle, poolAddress, alice);
      expect(Number(errVal) & 4).to.equal(4); // bit 2 set

      // Bob should have 0 (silent fail)
      const bobBal = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(bob.address),
        poolAddress,
        bob
      );
      expect(bobBal).to.equal(0n);
    });

    it("should reset daily spending after SPENDING_PERIOD", async function () {
      // Set limit to 2 USDC
      const limitInput = fhevm.createEncryptedInput(poolAddress, alice.address);
      limitInput.add64(2_000_000n);
      const limitEnc = await limitInput.encrypt();
      await pool.connect(alice).setSpendingLimit(limitEnc.handles[0], limitEnc.inputProof);

      // Pay 2 USDC — exactly at limit
      const nonce1 = randomNonce();
      const input1 = fhevm.createEncryptedInput(poolAddress, alice.address);
      input1.add64(2_000_000n);
      const enc1 = await input1.encrypt();
      await pool.connect(alice).pay(bob.address, enc1.handles[0], enc1.inputProof, 2_000_000, nonce1, ethers.ZeroHash);

      // Error should be 0 (within limit)
      const err1 = await fhevm.userDecryptEuint(FhevmType.euint8, await pool.lastPayError(alice.address), poolAddress, alice);
      expect(err1).to.equal(0n);

      // Advance time by 1 day + 1 second
      await ethers.provider.send("evm_increaseTime", [86401]);
      await ethers.provider.send("evm_mine", []);

      // Pay 2 USDC again — should succeed after daily reset
      const nonce2 = randomNonce();
      const input2 = fhevm.createEncryptedInput(poolAddress, alice.address);
      input2.add64(2_000_000n);
      const enc2 = await input2.encrypt();
      await pool.connect(alice).pay(bob.address, enc2.handles[0], enc2.inputProof, 2_000_000, nonce2, ethers.ZeroHash);

      const err2 = await fhevm.userDecryptEuint(FhevmType.euint8, await pool.lastPayError(alice.address), poolAddress, alice);
      expect(err2).to.equal(0n);
    });

    it("should allow unlimited pay after removeSpendingLimit", async function () {
      // Set limit to 1 USDC
      const limitInput = fhevm.createEncryptedInput(poolAddress, alice.address);
      limitInput.add64(1_000_000n);
      const limitEnc = await limitInput.encrypt();
      await pool.connect(alice).setSpendingLimit(limitEnc.handles[0], limitEnc.inputProof);

      // Remove it
      await pool.connect(alice).removeSpendingLimit();

      // Pay 10 USDC — should succeed (no limit)
      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(10_000_000n);
      const encrypted = await input.encrypt();
      await pool.connect(alice).pay(bob.address, encrypted.handles[0], encrypted.inputProof, 10_000_000, nonce, ethers.ZeroHash);

      const errHandle = await pool.lastPayError(alice.address);
      const errVal = await fhevm.userDecryptEuint(FhevmType.euint8, errHandle, poolAddress, alice);
      expect(errVal).to.equal(0n);
    });
  });

  // ═══════════════════════════════════════
  // Fee Rounding — FHE.rem (2 tests)
  // ═══════════════════════════════════════

  describe("Fee Rounding (FHE.rem)", function () {
    it("should round up fee when remainder > 0", async function () {
      // Amount = 10_000_001 (10.000001 USDC)
      // product = 10_000_001 * 10 = 100_000_010
      // percentageFee = 100_000_010 / 10_000 = 10_000 (rem = 10)
      // Round up: 10_000 + 1 = 10_001
      // Fee = max(10_001, 10_000) = 10_001
      // Bob gets: 10_000_001 - 10_001 = 9_990_000
      const treasuryBefore = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(treasury.address),
        poolAddress,
        treasury
      );

      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(10_000_001n);
      const encrypted = await input.encrypt();

      await pool.connect(alice).pay(
        bob.address, encrypted.handles[0], encrypted.inputProof,
        10_000_001, nonce, ethers.ZeroHash
      );

      const treasuryAfter = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(treasury.address),
        poolAddress,
        treasury
      );

      // Fee should be 10_001 (rounded up from 10_000)
      expect(treasuryAfter - treasuryBefore).to.equal(10_001n);
    });

    it("should not round up when remainder is 0", async function () {
      const treasuryBefore = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(treasury.address),
        poolAddress,
        treasury
      );

      // Amount = 10_000_000 — exact multiple, no remainder
      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(10_000_000n);
      const encrypted = await input.encrypt();

      await pool.connect(alice).pay(
        bob.address, encrypted.handles[0], encrypted.inputProof,
        10_000_000, nonce, ethers.ZeroHash
      );

      const treasuryAfter = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(treasury.address),
        poolAddress,
        treasury
      );

      // Fee should be exactly 10_000 (no round up)
      expect(treasuryAfter - treasuryBefore).to.equal(10_000n);
    });
  });

  // ═══════════════════════════════════════
  // XOR Diagnostic — FHE.xor + FHE.not (3 tests)
  // ═══════════════════════════════════════

  describe("XOR Error Diagnostic (FHE.xor, FHE.not)", function () {
    it("should return true when exactly one error (insufficient only)", async function () {
      // Alice has ~49_950_000; pay 60_000_000 (insufficient) but minPrice = 60_000_000 (meets price)
      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(60_000_000n);
      const encrypted = await input.encrypt();

      await pool.connect(alice).pay(
        bob.address, encrypted.handles[0], encrypted.inputProof,
        60_000_000, nonce, ethers.ZeroHash
      );

      // Exactly one error: insufficient only, not below min
      const xorHandle = await pool.lastPayExactlyOneError(alice.address);
      const xorVal = await fhevm.userDecryptEbool(xorHandle, poolAddress, alice);
      expect(xorVal).to.equal(true);
    });

    it("should return false when both errors present", async function () {
      // Bob has no balance; encrypt 500_000 but minPrice = 1_000_000
      // Both: insufficient (no balance) AND below min price
      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, bob.address);
      input.add64(500_000n);
      const encrypted = await input.encrypt();

      await pool.connect(bob).pay(
        alice.address, encrypted.handles[0], encrypted.inputProof,
        1_000_000, nonce, ethers.ZeroHash
      );

      // Both errors: xor = false
      const xorHandle = await pool.lastPayExactlyOneError(bob.address);
      const xorVal = await fhevm.userDecryptEbool(xorHandle, poolAddress, bob);
      expect(xorVal).to.equal(false);
    });

    it("should return false when no errors (successful pay)", async function () {
      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(1_000_000n);
      const encrypted = await input.encrypt();

      await pool.connect(alice).pay(
        bob.address, encrypted.handles[0], encrypted.inputProof,
        1_000_000, nonce, ethers.ZeroHash
      );

      // No errors: xor(false, false) = false
      const xorHandle = await pool.lastPayExactlyOneError(alice.address);
      const xorVal = await fhevm.userDecryptEbool(xorHandle, poolAddress, alice);
      expect(xorVal).to.equal(false);
    });
  });
});
