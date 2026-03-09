import { expect } from "chai";
import { ethers } from "hardhat";
import { fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";

/**
 * Real Sepolia on-chain integration tests.
 *
 * These tests deploy fresh contracts on Ethereum Sepolia and use the real Zama
 * FHE coprocessor for encryption/decryption. They require:
 *   - PRIVATE_KEY env var (funded Sepolia wallet, ~0.3 ETH)
 *   - SEPOLIA_RPC_URL env var (Sepolia RPC endpoint)
 *
 * Run with:  npm run test:sepolia
 *
 * On the local Hardhat network (npx hardhat test) these also run using mock FHE.
 */
describe("FHE x402 — Sepolia On-Chain Integration", function () {
  this.timeout(600_000); // 10 min global timeout

  let pool: any;
  let usdc: any;
  let deployer: any;
  let bob: any;
  let treasury: any;
  let poolAddress: string;
  let usdcAddress: string;

  function randomNonce(): string {
    return ethers.hexlify(ethers.randomBytes(32));
  }

  function findEvent(receipt: any, eventName: string): any {
    return receipt.logs.find((log: any) => {
      try {
        const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
        return parsed?.name === eventName;
      } catch {
        return false;
      }
    });
  }

  before(async function () {
    this.timeout(600_000);

    const signers = await ethers.getSigners();
    deployer = signers[0];

    console.log("\n══════════════════════════════════════════════════");
    console.log("  FHE x402 — Sepolia On-Chain Integration Tests");
    console.log("══════════════════════════════════════════════════");
    console.log(`  Deployer: ${deployer.address}`);

    // Use a separate treasury address (generated wallet, no ETH needed — only receives encrypted fees)
    treasury = ethers.Wallet.createRandom();
    console.log(`  Treasury: ${treasury.address}`);

    // Deploy fresh MockUSDC
    console.log("\n  Deploying MockUSDC...");
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();
    usdcAddress = await usdc.getAddress();
    console.log(`  MockUSDC: ${usdcAddress}`);

    // Deploy fresh ConfidentialPaymentPool (separate treasury)
    console.log("  Deploying ConfidentialPaymentPool...");
    const Pool = await ethers.getContractFactory("ConfidentialPaymentPool");
    pool = await Pool.deploy(usdcAddress, treasury.address);
    await pool.waitForDeployment();
    poolAddress = await pool.getAddress();
    console.log(`  Pool: ${poolAddress}`);

    // Mint 1000 USDC to deployer
    const mintTx = await usdc.mint(deployer.address, 1_000_000_000n); // 1000 USDC
    await mintTx.wait();
    console.log(`  Minted 1000 USDC to deployer`);

    // Approve pool
    const approveTx = await usdc.approve(poolAddress, 1_000_000_000n);
    await approveTx.wait();
    console.log(`  Approved pool to spend deployer USDC`);

    // Create and fund bob (random wallet, needs ETH for gas)
    bob = ethers.Wallet.createRandom().connect(ethers.provider);
    const fundTx = await deployer.sendTransaction({
      to: bob.address,
      value: ethers.parseEther("0.05"),
    });
    await fundTx.wait();
    console.log(`  Bob: ${bob.address} (funded 0.05 ETH)`);

    // Mint + approve USDC for bob
    const bobMintTx = await usdc.mint(bob.address, 100_000_000n); // 100 USDC
    await bobMintTx.wait();
    const bobApproveTx = await usdc.connect(bob).approve(poolAddress, 100_000_000n);
    await bobApproveTx.wait();
    console.log(`  Minted 100 USDC to bob + approved`);

    console.log("\n  Setup complete.\n");
  });

  // ═══════════════════════════════════════
  // Deposit Tests
  // ═══════════════════════════════════════

  describe("Deposit", function () {
    this.timeout(600_000);

    it("should deposit and credit real encrypted balance", async function () {
      const depositAmount = 50_000_000; // 50 USDC
      const tx = await pool.deposit(depositAmount);
      const receipt = await tx.wait();
      console.log(`    deposit TX: ${tx.hash}`);

      // fee = max(50_000_000 * 10 / 10_000, 10_000) = max(50_000, 10_000) = 50_000
      // net = 50_000_000 - 50_000 = 49_950_000
      const encBalance = await pool.balanceOf(deployer.address);
      const balance = await fhevm.userDecryptEuint(
        FhevmType.euint64, encBalance, poolAddress, deployer
      );
      console.log(`    Deployer balance: ${balance} (expected 49_950_000)`);
      expect(balance).to.equal(49_950_000n);
    });

    it("should apply min fee for small deposit (real FHE)", async function () {
      // Deposit 0.02 USDC (20_000 micro-USDC)
      // fee = max(20_000 * 10 / 10_000, 10_000) = max(20, 10_000) = 10_000
      // net = 20_000 - 10_000 = 10_000
      const balBefore = await fhevm.userDecryptEuint(
        FhevmType.euint64, await pool.balanceOf(deployer.address), poolAddress, deployer
      );

      const tx = await pool.deposit(20_000);
      await tx.wait();
      console.log(`    small deposit TX: ${tx.hash}`);

      const balAfter = await fhevm.userDecryptEuint(
        FhevmType.euint64, await pool.balanceOf(deployer.address), poolAddress, deployer
      );
      expect(balAfter - balBefore).to.equal(10_000n);
    });

    it("should mark user as initialized", async function () {
      expect(await pool.isInitialized(deployer.address)).to.equal(true);
    });
  });

  // ═══════════════════════════════════════
  // Pay Tests (encrypted)
  // ═══════════════════════════════════════

  describe("Pay", function () {
    this.timeout(600_000);

    it("should encrypt amount and pay recipient (real FHE)", async function () {
      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, deployer.address);
      input.add64(5_000_000n); // 5 USDC
      const encrypted = await input.encrypt();

      const tx = await pool.pay(
        bob.address, encrypted.handles[0], encrypted.inputProof, 5_000_000, nonce, ethers.ZeroHash
      );
      await tx.wait();
      console.log(`    pay TX: ${tx.hash}`);

      // Bob receives 5_000_000 - fee(10_000) = 4_990_000
      const bobEnc = await pool.balanceOf(bob.address);
      const bobBal = await fhevm.userDecryptEuint(
        FhevmType.euint64, bobEnc, poolAddress, bob
      );
      console.log(`    Bob balance: ${bobBal} (expected 4_990_000)`);
      expect(bobBal).to.equal(4_990_000n);
    });

    it("should emit PaymentExecuted event", async function () {
      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, deployer.address);
      input.add64(1_000_000n);
      const encrypted = await input.encrypt();

      const tx = await pool.pay(
        bob.address, encrypted.handles[0], encrypted.inputProof, 1_000_000, nonce, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      console.log(`    pay TX: ${tx.hash}`);

      const event = findEvent(receipt, "PaymentExecuted");
      expect(event).to.not.be.undefined;
    });

    it("should prevent nonce reuse", async function () {
      const nonce = randomNonce();
      const input1 = fhevm.createEncryptedInput(poolAddress, deployer.address);
      input1.add64(1_000_000n);
      const enc1 = await input1.encrypt();

      const tx = await pool.pay(
        bob.address, enc1.handles[0], enc1.inputProof, 1_000_000, nonce, ethers.ZeroHash
      );
      await tx.wait();
      console.log(`    first pay TX: ${tx.hash}`);

      const input2 = fhevm.createEncryptedInput(poolAddress, deployer.address);
      input2.add64(1_000_000n);
      const enc2 = await input2.encrypt();

      await expect(
        pool.pay(bob.address, enc2.handles[0], enc2.inputProof, 1_000_000, nonce, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(pool, "NonceAlreadyUsed");
    });

    it("should silently transfer 0 on insufficient balance", async function () {
      const bobBalBefore = await fhevm.userDecryptEuint(
        FhevmType.euint64, await pool.balanceOf(bob.address), poolAddress, bob
      );

      // Bob tries to pay deployer more than he has
      const nonce = randomNonce();
      const input = fhevm.createEncryptedInput(poolAddress, bob.address);
      input.add64(999_000_000n); // Way more than bob has
      const encrypted = await input.encrypt();

      const tx = await pool.connect(bob).pay(
        deployer.address, encrypted.handles[0], encrypted.inputProof, 1_000_000, nonce, ethers.ZeroHash
      );
      await tx.wait();
      console.log(`    silent fail TX: ${tx.hash}`);

      // Bob balance unchanged (silent failure transferred 0)
      const bobBalAfter = await fhevm.userDecryptEuint(
        FhevmType.euint64, await pool.balanceOf(bob.address), poolAddress, bob
      );
      expect(bobBalAfter).to.equal(bobBalBefore);
    });

    it("should credit fee to treasury", async function () {
      // Treasury is a separate address — check it has accrued fees
      const treasuryBal = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceOf(treasury.address),
        poolAddress,
        treasury.connect(ethers.provider)
      );
      console.log(`    Treasury balance: ${treasuryBal}`);
      expect(treasuryBal).to.be.greaterThan(0n);
    });
  });

  // ═══════════════════════════════════════
  // Withdraw Tests (2-step)
  // ═══════════════════════════════════════

  describe("Withdraw", function () {
    this.timeout(600_000);

    it("should request withdraw with real encrypted amount", async function () {
      // Bob requests withdrawal of 1 USDC
      const input = fhevm.createEncryptedInput(poolAddress, bob.address);
      input.add64(1_000_000n);
      const encrypted = await input.encrypt();

      const tx = await pool.connect(bob).requestWithdraw(encrypted.handles[0], encrypted.inputProof);
      await tx.wait();
      console.log(`    requestWithdraw TX: ${tx.hash}`);

      expect(await pool.withdrawRequested(bob.address)).to.equal(true);

      // Pending handle should be nonzero
      const pendingHandle = await pool.pendingWithdrawOf(bob.address);
      expect(pendingHandle).to.not.equal(0n);
    });

    it("should cancel and refund", async function () {
      // Bob cancels his pending withdrawal
      const balBefore = await fhevm.userDecryptEuint(
        FhevmType.euint64, await pool.balanceOf(bob.address), poolAddress, bob
      );

      const tx = await pool.connect(bob).cancelWithdraw();
      await tx.wait();
      console.log(`    cancelWithdraw TX: ${tx.hash}`);

      expect(await pool.withdrawRequested(bob.address)).to.equal(false);

      // Balance should be restored (balBefore + 1_000_000 refunded)
      const balAfter = await fhevm.userDecryptEuint(
        FhevmType.euint64, await pool.balanceOf(bob.address), poolAddress, bob
      );
      expect(balAfter - balBefore).to.equal(1_000_000n);
    });

    it("should finalize with real KMS decryption proof", async function () {
      // Bob requests withdrawal again
      const withdrawAmount = 2_000_000n; // 2 USDC
      const input = fhevm.createEncryptedInput(poolAddress, bob.address);
      input.add64(withdrawAmount);
      const encrypted = await input.encrypt();

      const reqTx = await pool.connect(bob).requestWithdraw(encrypted.handles[0], encrypted.inputProof);
      await reqTx.wait();
      console.log(`    requestWithdraw TX: ${reqTx.hash}`);

      // Get pending handle and decrypt via KMS
      const pendingHandle = await pool.pendingWithdrawOf(bob.address);
      const decryptResult = await fhevm.publicDecrypt([pendingHandle]);
      const clearAmount = BigInt(decryptResult.clearValues[pendingHandle]);
      const proof = decryptResult.decryptionProof;
      console.log(`    KMS decrypted amount: ${clearAmount}`);

      const usdcBefore = await usdc.balanceOf(bob.address);

      const finTx = await pool.connect(bob).finalizeWithdraw(Number(clearAmount), proof);
      await finTx.wait();
      console.log(`    finalizeWithdraw TX: ${finTx.hash}`);

      expect(await pool.withdrawRequested(bob.address)).to.equal(false);

      // Bob receives USDC minus withdrawal fee
      // fee = max(2_000_000 * 10 / 10_000, 10_000) = max(2_000, 10_000) = 10_000
      // net = 2_000_000 - 10_000 = 1_990_000
      const usdcAfter = await usdc.balanceOf(bob.address);
      expect(usdcAfter - usdcBefore).to.equal(1_990_000n);
    });
  });

  // ═══════════════════════════════════════
  // Balance Query Tests
  // ═══════════════════════════════════════

  describe("Balance Query", function () {
    this.timeout(600_000);

    it("should create snapshot and decrypt via publicDecrypt", async function () {
      const tx = await pool.requestBalance();
      await tx.wait();
      console.log(`    requestBalance TX: ${tx.hash}`);

      expect(await pool.balanceQueryRequested(deployer.address)).to.equal(true);

      // Read the snapshot handle
      const snapshotHandle = await pool.balanceSnapshotOf(deployer.address);
      expect(snapshotHandle).to.not.equal(0n);

      // Snapshot is made publicly decryptable — use publicDecrypt (not userDecrypt)
      const decryptResult = await fhevm.publicDecrypt([snapshotHandle]);
      const snapshotBal = BigInt(decryptResult.clearValues[snapshotHandle]);
      console.log(`    Snapshot balance: ${snapshotBal}`);
      expect(snapshotBal).to.be.greaterThan(0n);
    });
  });

  // ═══════════════════════════════════════
  // Full End-to-End Flow
  // ═══════════════════════════════════════

  describe("Full Flow (e2e)", function () {
    this.timeout(600_000);

    it("deposit → pay → query → withdraw (all real)", async function () {
      console.log("\n    ── E2E: Fresh deposit by bob ──");

      // 1. Bob deposits 10 USDC
      const depositTx = await pool.connect(bob).deposit(10_000_000);
      await depositTx.wait();
      console.log(`    Bob deposit TX: ${depositTx.hash}`);

      // fee = max(10_000_000 * 10 / 10_000, 10_000) = max(10_000, 10_000) = 10_000
      // net = 10_000_000 - 10_000 = 9_990_000
      const bobBalAfterDeposit = await fhevm.userDecryptEuint(
        FhevmType.euint64, await pool.balanceOf(bob.address), poolAddress, bob
      );
      console.log(`    Bob balance after deposit: ${bobBalAfterDeposit}`);

      // 2. Bob pays deployer 3 USDC (deployer != treasury, so this is valid)
      console.log("\n    ── E2E: Bob pays deployer 3 USDC ──");
      const nonce = randomNonce();
      const payInput = fhevm.createEncryptedInput(poolAddress, bob.address);
      payInput.add64(3_000_000n);
      const payEncrypted = await payInput.encrypt();

      const payTx = await pool.connect(bob).pay(
        deployer.address, payEncrypted.handles[0], payEncrypted.inputProof, 3_000_000, nonce, ethers.ZeroHash
      );
      const payReceipt = await payTx.wait();
      console.log(`    Pay TX: ${payTx.hash}`);

      const payEvent = findEvent(payReceipt, "PaymentExecuted");
      expect(payEvent).to.not.be.undefined;

      // 3. Query balances
      console.log("\n    ── E2E: Query balances ──");
      const bobBal = await fhevm.userDecryptEuint(
        FhevmType.euint64, await pool.balanceOf(bob.address), poolAddress, bob
      );
      const deployerBal = await fhevm.userDecryptEuint(
        FhevmType.euint64, await pool.balanceOf(deployer.address), poolAddress, deployer
      );
      console.log(`    Bob: ${bobBal}`);
      console.log(`    Deployer: ${deployerBal}`);

      // Bob should have lost 3_000_000 from his balance
      expect(bobBalAfterDeposit - bobBal).to.equal(3_000_000n);

      // 4. Bob withdraws 1 USDC
      console.log("\n    ── E2E: Bob withdraws 1 USDC ──");
      const wInput = fhevm.createEncryptedInput(poolAddress, bob.address);
      wInput.add64(1_000_000n);
      const wEncrypted = await wInput.encrypt();

      const reqTx = await pool.connect(bob).requestWithdraw(wEncrypted.handles[0], wEncrypted.inputProof);
      await reqTx.wait();
      console.log(`    requestWithdraw TX: ${reqTx.hash}`);

      const pendingHandle = await pool.pendingWithdrawOf(bob.address);
      const decryptResult = await fhevm.publicDecrypt([pendingHandle]);
      const clearAmount = BigInt(decryptResult.clearValues[pendingHandle]);
      const proof = decryptResult.decryptionProof;
      console.log(`    KMS decrypted: ${clearAmount}`);

      const bobUsdcBefore = await usdc.balanceOf(bob.address);
      const finTx = await pool.connect(bob).finalizeWithdraw(Number(clearAmount), proof);
      await finTx.wait();
      console.log(`    finalizeWithdraw TX: ${finTx.hash}`);

      const bobUsdcAfter = await usdc.balanceOf(bob.address);
      // fee = max(1_000_000 * 10 / 10_000, 10_000) = max(1_000, 10_000) = 10_000
      // net = 1_000_000 - 10_000 = 990_000
      expect(bobUsdcAfter - bobUsdcBefore).to.equal(990_000n);

      console.log("\n    ── E2E Complete ──\n");
    });
  });
});
