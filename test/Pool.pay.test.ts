import { expect } from "chai";
import { ethers } from "hardhat";
import { fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("ConfidentialPaymentPool — Pay", function () {
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
    await pool.connect(alice).deposit(50_000_000); // ~49_950_000 net
  });

  function randomNonce(): string {
    return ethers.hexlify(ethers.randomBytes(32));
  }

  it("should execute payment from alice to bob", async function () {
    const nonce = randomNonce();
    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(1_000_000n); // 1 USDC
    const encrypted = await input.encrypt();

    await pool.connect(alice).pay(
      bob.address,
      encrypted.handles[0],
      encrypted.inputProof,
      1_000_000, // minPrice
      nonce,
      ethers.ZeroHash
    );

    // Bob should receive 1_000_000 - fee
    // Fee = max(1_000_000 * 10 / 10_000, 10_000) = max(1_000, 10_000) = 10_000
    // Bob net = 1_000_000 - 10_000 = 990_000
    const bobEnc = await pool.balanceOf(bob.address);
    const bobBal = await fhevm.userDecryptEuint(FhevmType.euint64, bobEnc, poolAddress, bob);
    expect(bobBal).to.equal(990_000n);
  });

  it("should emit PaymentExecuted event", async function () {
    const nonce = randomNonce();
    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(2_000_000n);
    const encrypted = await input.encrypt();

    const tx = await pool.connect(alice).pay(
      bob.address,
      encrypted.handles[0],
      encrypted.inputProof,
      1_000_000,
      nonce,
      ethers.ZeroHash
    );
    const receipt = await tx.wait();

    const event = receipt.logs.find((log: any) => {
      try {
        const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
        return parsed?.name === "PaymentExecuted";
      } catch {
        return false;
      }
    });
    expect(event).to.not.be.undefined;
  });

  it("should prevent nonce reuse", async function () {
    const nonce = randomNonce();
    const input1 = fhevm.createEncryptedInput(poolAddress, alice.address);
    input1.add64(1_000_000n);
    const enc1 = await input1.encrypt();

    await pool.connect(alice).pay(bob.address, enc1.handles[0], enc1.inputProof, 1_000_000, nonce, ethers.ZeroHash);

    const input2 = fhevm.createEncryptedInput(poolAddress, alice.address);
    input2.add64(1_000_000n);
    const enc2 = await input2.encrypt();

    await expect(
      pool.connect(alice).pay(bob.address, enc2.handles[0], enc2.inputProof, 1_000_000, nonce, ethers.ZeroHash)
    ).to.be.revertedWithCustomError(pool, "NonceAlreadyUsed");
  });

  it("should revert on zero address recipient", async function () {
    const nonce = randomNonce();
    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(1_000_000n);
    const encrypted = await input.encrypt();

    await expect(
      pool.connect(alice).pay(
        ethers.ZeroAddress,
        encrypted.handles[0],
        encrypted.inputProof,
        1_000_000,
        nonce,
        ethers.ZeroHash
      )
    ).to.be.revertedWithCustomError(pool, "ZeroAddress");
  });

  it("should silently transfer 0 when insufficient balance", async function () {
    // Bob has no balance
    const nonce = randomNonce();
    const input = fhevm.createEncryptedInput(poolAddress, bob.address);
    input.add64(1_000_000n);
    const encrypted = await input.encrypt();

    // Get alice's balance before
    const aliceEncBefore = await pool.balanceOf(alice.address);
    const aliceBalBefore = await fhevm.userDecryptEuint(FhevmType.euint64, aliceEncBefore, poolAddress, alice);

    // Should NOT revert — silent failure
    await pool.connect(bob).pay(alice.address, encrypted.handles[0], encrypted.inputProof, 1_000_000, nonce, ethers.ZeroHash);

    // Alice balance should be unchanged (bob had no funds → 0 transferred)
    const aliceEncAfter = await pool.balanceOf(alice.address);
    const aliceBalAfter = await fhevm.userDecryptEuint(FhevmType.euint64, aliceEncAfter, poolAddress, alice);
    expect(aliceBalAfter).to.equal(aliceBalBefore);
  });

  it("should silently transfer 0 when amount < minPrice", async function () {
    const nonce = randomNonce();
    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(500_000n); // 0.5 USDC
    const encrypted = await input.encrypt();

    // minPrice = 1 USDC, but encrypted amount = 0.5 USDC
    await pool.connect(alice).pay(bob.address, encrypted.handles[0], encrypted.inputProof, 1_000_000, nonce, ethers.ZeroHash);

    // Bob should have 0 (silent failure)
    const bobEnc = await pool.balanceOf(bob.address);
    const bobBal = await fhevm.userDecryptEuint(FhevmType.euint64, bobEnc, poolAddress, bob);
    expect(bobBal).to.equal(0n);
  });

  it("should deduct correct amount from sender", async function () {
    const aliceEncBefore = await pool.balanceOf(alice.address);
    const aliceBalBefore = await fhevm.userDecryptEuint(FhevmType.euint64, aliceEncBefore, poolAddress, alice);

    const nonce = randomNonce();
    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(5_000_000n);
    const encrypted = await input.encrypt();

    await pool.connect(alice).pay(bob.address, encrypted.handles[0], encrypted.inputProof, 5_000_000, nonce, ethers.ZeroHash);

    const aliceEncAfter = await pool.balanceOf(alice.address);
    const aliceBalAfter = await fhevm.userDecryptEuint(FhevmType.euint64, aliceEncAfter, poolAddress, alice);

    // Alice should have lost 5_000_000
    expect(aliceBalBefore - aliceBalAfter).to.equal(5_000_000n);
  });

  it("should credit fee to treasury on payment", async function () {
    const nonce = randomNonce();
    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(10_000_000n); // 10 USDC
    const encrypted = await input.encrypt();

    // minPrice = 10 USDC → fee = max(10_000_000 * 10/10_000, 10_000) = max(10_000, 10_000) = 10_000
    await pool.connect(alice).pay(bob.address, encrypted.handles[0], encrypted.inputProof, 10_000_000, nonce, ethers.ZeroHash);

    const treasuryEnc = await pool.balanceOf(treasury.address);
    const treasuryBal = await fhevm.userDecryptEuint(FhevmType.euint64, treasuryEnc, poolAddress, treasury);
    // Treasury gets deposit fee (50_000 from 50M deposit) + pay fee (10_000)
    expect(treasuryBal).to.equal(60_000n);
  });

  it("should handle multiple payments from same sender", async function () {
    for (let i = 0; i < 3; i++) {
      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, alice.address);
      input.add64(1_000_000n);
      const encrypted = await input.encrypt();
      await pool.connect(alice).pay(bob.address, encrypted.handles[0], encrypted.inputProof, 1_000_000, nonce, ethers.ZeroHash);
    }

    const bobEnc = await pool.balanceOf(bob.address);
    const bobBal = await fhevm.userDecryptEuint(FhevmType.euint64, bobEnc, poolAddress, bob);
    // 3 * (1_000_000 - 10_000) = 2_970_000
    expect(bobBal).to.equal(2_970_000n);
  });

  it("should allow paying with amount exactly equal to minPrice", async function () {
    const nonce = randomNonce();
    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(2_000_000n);
    const encrypted = await input.encrypt();

    await pool.connect(alice).pay(bob.address, encrypted.handles[0], encrypted.inputProof, 2_000_000, nonce, ethers.ZeroHash);

    const bobEnc = await pool.balanceOf(bob.address);
    const bobBal = await fhevm.userDecryptEuint(FhevmType.euint64, bobEnc, poolAddress, bob);
    // fee = max(2_000_000*10/10_000, 10_000) = max(2_000, 10_000) = 10_000
    expect(bobBal).to.equal(1_990_000n);
  });

  it("should allow paying with amount greater than minPrice", async function () {
    const nonce = randomNonce();
    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(5_000_000n); // 5 USDC
    const encrypted = await input.encrypt();

    // minPrice = 1 USDC, but paying 5 USDC
    await pool.connect(alice).pay(bob.address, encrypted.handles[0], encrypted.inputProof, 1_000_000, nonce, ethers.ZeroHash);

    const bobEnc = await pool.balanceOf(bob.address);
    const bobBal = await fhevm.userDecryptEuint(FhevmType.euint64, bobEnc, poolAddress, bob);
    // fee = max(1_000_000*10/10_000, 10_000) = max(1_000, 10_000) = 10_000 (from minPrice)
    // bob gets 5_000_000 - 10_000 = 4_990_000
    expect(bobBal).to.equal(4_990_000n);
  });

  it("should mark nonce as used after payment", async function () {
    const nonce = randomNonce();
    expect(await pool.usedNonces(nonce)).to.equal(false);

    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(1_000_000n);
    const encrypted = await input.encrypt();

    await pool.connect(alice).pay(bob.address, encrypted.handles[0], encrypted.inputProof, 1_000_000, nonce, ethers.ZeroHash);
    expect(await pool.usedNonces(nonce)).to.equal(true);
  });

  it("should mark nonce as used even on silent failure", async function () {
    // Bob has no funds
    const nonce = randomNonce();
    const input = fhevm.createEncryptedInput(poolAddress, bob.address);
    input.add64(1_000_000n);
    const encrypted = await input.encrypt();

    await pool.connect(bob).pay(alice.address, encrypted.handles[0], encrypted.inputProof, 1_000_000, nonce, ethers.ZeroHash);
    expect(await pool.usedNonces(nonce)).to.equal(true);
  });

  it("should handle different unique nonces", async function () {
    const nonce1 = randomNonce();
    const nonce2 = randomNonce();

    const input1 = fhevm.createEncryptedInput(poolAddress, alice.address);
    input1.add64(1_000_000n);
    const enc1 = await input1.encrypt();

    const input2 = fhevm.createEncryptedInput(poolAddress, alice.address);
    input2.add64(1_000_000n);
    const enc2 = await input2.encrypt();

    await pool.connect(alice).pay(bob.address, enc1.handles[0], enc1.inputProof, 1_000_000, nonce1, ethers.ZeroHash);
    await pool.connect(alice).pay(bob.address, enc2.handles[0], enc2.inputProof, 1_000_000, nonce2, ethers.ZeroHash);

    // Both should succeed
    const bobEnc = await pool.balanceOf(bob.address);
    const bobBal = await fhevm.userDecryptEuint(FhevmType.euint64, bobEnc, poolAddress, bob);
    expect(bobBal).to.equal(1_980_000n); // 2 * 990_000
  });

  it("should revert when minPrice < MIN_PROTOCOL_FEE", async function () {
    const nonce = randomNonce();
    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(5_000n);
    const encrypted = await input.encrypt();

    await expect(
      pool.connect(alice).pay(bob.address, encrypted.handles[0], encrypted.inputProof, 5_000, nonce, ethers.ZeroHash)
    ).to.be.revertedWithCustomError(pool, "MinPriceTooLow");
  });

  it("should revert when paying to treasury address", async function () {
    const nonce = randomNonce();
    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(1_000_000n);
    const encrypted = await input.encrypt();

    await expect(
      pool.connect(alice).pay(treasury.address, encrypted.handles[0], encrypted.inputProof, 1_000_000, nonce, ethers.ZeroHash)
    ).to.be.revertedWithCustomError(pool, "InvalidRecipient");
  });

  it("should accept minPrice exactly at MIN_PROTOCOL_FEE", async function () {
    const nonce = randomNonce();
    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(10_000n); // exactly MIN_PROTOCOL_FEE
    const encrypted = await input.encrypt();

    // minPrice = 10_000, fee = 10_000, net = 0 → bob gets 0 but tx succeeds
    await pool.connect(alice).pay(bob.address, encrypted.handles[0], encrypted.inputProof, 10_000, nonce, ethers.ZeroHash);

    const bobEnc = await pool.balanceOf(bob.address);
    const bobBal = await fhevm.userDecryptEuint(FhevmType.euint64, bobEnc, poolAddress, bob);
    expect(bobBal).to.equal(0n); // fee consumed entire amount
  });

  it("should emit PaymentExecuted even on silent failure", async function () {
    // Bob has no funds → silent failure
    const nonce = randomNonce();
    const input = fhevm.createEncryptedInput(poolAddress, bob.address);
    input.add64(1_000_000n);
    const encrypted = await input.encrypt();

    const tx = await pool.connect(bob).pay(alice.address, encrypted.handles[0], encrypted.inputProof, 1_000_000, nonce, ethers.ZeroHash);
    const receipt = await tx.wait();

    const event = receipt.logs.find((log: any) => {
      try {
        const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
        return parsed?.name === "PaymentExecuted";
      } catch {
        return false;
      }
    });
    // Event fires even on 0-transfer (inherent to FHE silent failure)
    expect(event).to.not.be.undefined;
  });
});
