import { expect } from "chai";
import { ethers } from "hardhat";
import { fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("ConfidentialPaymentPool — Fee", function () {
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

    await usdc.mint(alice.address, 500_000_000n);
    await usdc.connect(alice).approve(poolAddress, 500_000_000n);
  });

  it("should apply MIN_PROTOCOL_FEE (0.01 USDC) for small amounts", async function () {
    // Deposit 1 USDC: fee = max(1_000_000*10/10_000, 10_000) = max(1_000, 10_000) = 10_000
    await pool.connect(alice).deposit(1_000_000);

    const encBal = await pool.balanceOf(alice.address);
    const balance = await fhevm.userDecryptEuint(FhevmType.euint64, encBal, poolAddress, alice);
    expect(balance).to.equal(990_000n); // 1_000_000 - 10_000
  });

  it("should apply percentage fee for large amounts", async function () {
    // Deposit 100 USDC: fee = max(100_000_000*10/10_000, 10_000) = max(100_000, 10_000) = 100_000
    await pool.connect(alice).deposit(100_000_000);

    const encBal = await pool.balanceOf(alice.address);
    const balance = await fhevm.userDecryptEuint(FhevmType.euint64, encBal, poolAddress, alice);
    expect(balance).to.equal(99_900_000n); // 100_000_000 - 100_000
  });

  it("should have breakeven at 10 USDC", async function () {
    // At 10 USDC: fee = max(10_000_000*10/10_000, 10_000) = max(10_000, 10_000) = 10_000
    // Both formulas give same result
    await pool.connect(alice).deposit(10_000_000);

    const encBal = await pool.balanceOf(alice.address);
    const balance = await fhevm.userDecryptEuint(FhevmType.euint64, encBal, poolAddress, alice);
    expect(balance).to.equal(9_990_000n);
  });

  it("should accumulate treasury fees from deposits", async function () {
    await pool.connect(alice).deposit(10_000_000); // fee = 10_000
    await pool.connect(alice).deposit(50_000_000); // fee = 50_000

    const encTreasury = await pool.balanceOf(treasury.address);
    const treasuryBal = await fhevm.userDecryptEuint(FhevmType.euint64, encTreasury, poolAddress, treasury);
    expect(treasuryBal).to.equal(60_000n);
  });

  it("should accumulate treasury fees from payments", async function () {
    await pool.connect(alice).deposit(50_000_000); // fee = 50_000

    // Pay 20 USDC: minPrice fee = max(20_000_000*10/10_000, 10_000) = max(20_000, 10_000) = 20_000
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const input = fhevm.createEncryptedInput(poolAddress, alice.address);
    input.add64(20_000_000n);
    const encrypted = await input.encrypt();
    await pool.connect(alice).pay(bob.address, encrypted.handles[0], encrypted.inputProof, 20_000_000, nonce, ethers.ZeroHash);

    const encTreasury = await pool.balanceOf(treasury.address);
    const treasuryBal = await fhevm.userDecryptEuint(FhevmType.euint64, encTreasury, poolAddress, treasury);
    // Deposit fee (50_000) + pay fee (20_000) = 70_000
    expect(treasuryBal).to.equal(70_000n);
  });

  it("should not charge payment fee on silent failure", async function () {
    // Bob has no balance → payment will silently fail
    await pool.connect(alice).deposit(10_000_000); // fee = 10_000

    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const input = fhevm.createEncryptedInput(poolAddress, bob.address);
    input.add64(5_000_000n);
    const encrypted = await input.encrypt();
    await pool.connect(bob).pay(alice.address, encrypted.handles[0], encrypted.inputProof, 5_000_000, nonce, ethers.ZeroHash);

    const encTreasury = await pool.balanceOf(treasury.address);
    const treasuryBal = await fhevm.userDecryptEuint(FhevmType.euint64, encTreasury, poolAddress, treasury);
    // Only deposit fee (10_000), no pay fee because payment silently failed
    expect(treasuryBal).to.equal(10_000n);
  });

  it("should expose FEE_BPS constant", async function () {
    expect(await pool.FEE_BPS()).to.equal(10n);
  });

  it("should expose MIN_PROTOCOL_FEE constant", async function () {
    expect(await pool.MIN_PROTOCOL_FEE()).to.equal(10_000n);
  });

  it("should expose BPS constant", async function () {
    expect(await pool.BPS()).to.equal(10_000n);
  });

  it("should correctly calculate fee for exact breakeven amount", async function () {
    // percentageFee = 10_000_000 * 10 / 10_000 = 10_000 = MIN_PROTOCOL_FEE
    // Both are equal, min fee wins (they're same)
    await pool.connect(alice).deposit(10_000_000);
    const encBal = await pool.balanceOf(alice.address);
    const balance = await fhevm.userDecryptEuint(FhevmType.euint64, encBal, poolAddress, alice);
    expect(balance).to.equal(9_990_000n);
  });
});
