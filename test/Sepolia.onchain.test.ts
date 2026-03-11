/**
 * Sepolia On-Chain Integration Tests
 *
 * These tests run against REAL deployed contracts on Ethereum Sepolia.
 * They verify that the contracts work correctly on a live network.
 *
 * Prerequisites:
 *   - .env with PRIVATE_KEY (funded with Sepolia ETH + MockUSDC)
 *   - .env with SEPOLIA_RPC_URL
 *   - Deployed contracts (MockUSDC, ConfidentialUSDC, X402PaymentVerifier)
 *
 * Run: npx hardhat test test/Sepolia.onchain.test.ts --network sepolia
 */

import { expect } from "chai";
import hre from "hardhat";
import { ethers } from "hardhat";
import type { Contract, Signer } from "ethers";

// Deployed contract addresses on Sepolia
const MOCK_USDC_ADDRESS = "0xc89e913676B034f8b38E49f7508803d1cDEC9F4f";
const CONFIDENTIAL_USDC_ADDRESS = "0x3864B98D1B1EC2109C679679052e2844b4153889";
const X402_VERIFIER_ADDRESS = "0xCc60280A10FEB7fBdf20fBefc2abe6E0e99A5A83";

// Minimal ABIs — only what we need for testing
const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function mint(address, uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
];

const CUSDC_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function underlying() view returns (address)",
  "function rate() view returns (uint256)",
  "function treasury() view returns (address)",
  "function accumulatedFees() view returns (uint256)",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
  "function wrap(address to, uint256 amount)",
  "function confidentialBalanceOf(address) view returns (bytes32)",
  "function setOperator(address operator, uint48 until)",
  "function isOperator(address holder, address spender) view returns (bool)",
  "event ConfidentialTransfer(address indexed from, address indexed to, bytes32 indexed amount)",
  "event OperatorSet(address indexed holder, address indexed operator, uint48 until)",
];

const VERIFIER_ABI = [
  "function trustedToken() view returns (address)",
  "function usedNonces(bytes32) view returns (bool)",
  "function recordPayment(address server, bytes32 nonce, uint64 minPrice)",
  "function recordBatchPayment(address server, bytes32 nonce, uint32 requestCount, uint64 pricePerRequest)",
  "event PaymentVerified(address indexed payer, address indexed server, bytes32 indexed nonce, uint64 minPrice)",
  "event BatchPaymentRecorded(address indexed payer, address indexed server, bytes32 indexed nonce, uint32 requestCount, uint64 pricePerRequest)",
];

describe("Sepolia On-Chain Integration", function () {
  let signer: Signer;
  let signerAddress: string;
  let usdc: Contract;
  let cUSDC: Contract;
  let verifier: Contract;

  before(async function () {
    // Get signer from hardhat config (uses PRIVATE_KEY from .env)
    const signers = await ethers.getSigners();
    signer = signers[0];
    signerAddress = await signer.getAddress();

    console.log(`    Signer: ${signerAddress}`);

    // Connect to deployed contracts
    usdc = new ethers.Contract(MOCK_USDC_ADDRESS, USDC_ABI, signer);
    cUSDC = new ethers.Contract(CONFIDENTIAL_USDC_ADDRESS, CUSDC_ABI, signer);
    verifier = new ethers.Contract(X402_VERIFIER_ADDRESS, VERIFIER_ABI, signer);

    // Check ETH balance
    const ethBalance = await ethers.provider.getBalance(signerAddress);
    console.log(`    ETH Balance: ${ethers.formatEther(ethBalance)} ETH`);

    if (ethBalance === 0n) {
      throw new Error("Signer has no ETH. Fund the wallet with Sepolia ETH first.");
    }
  });

  // ===========================================================================
  // 1. Contract Deployment Verification
  // ===========================================================================

  describe("1. Contract Deployment Verification", function () {
    it("MockUSDC is deployed and responds", async function () {
      const name = await usdc.name();
      const symbol = await usdc.symbol();
      const decimals = await usdc.decimals();

      console.log(`      MockUSDC: ${name} (${symbol}), ${decimals} decimals`);

      expect(name).to.be.a("string");
      expect(decimals).to.equal(6n);
    });

    it("ConfidentialUSDC is deployed and responds", async function () {
      const name = await cUSDC.name();
      const symbol = await cUSDC.symbol();
      const decimals = await cUSDC.decimals();
      const underlying = await cUSDC.underlying();

      console.log(`      cUSDC: ${name} (${symbol}), ${decimals} decimals`);
      console.log(`      Underlying: ${underlying}`);

      expect(name).to.be.a("string");
      expect(decimals).to.equal(6n);
      expect(underlying.toLowerCase()).to.equal(MOCK_USDC_ADDRESS.toLowerCase());
    });

    it("X402PaymentVerifier is deployed and responds", async function () {
      const trustedToken = await verifier.trustedToken();

      console.log(`      Trusted Token: ${trustedToken}`);

      expect(trustedToken.toLowerCase()).to.equal(
        CONFIDENTIAL_USDC_ADDRESS.toLowerCase()
      );
    });

    it("ConfidentialUSDC owner and treasury are set", async function () {
      const owner = await cUSDC.owner();
      const treasury = await cUSDC.treasury();
      const paused = await cUSDC.paused();

      console.log(`      Owner: ${owner}`);
      console.log(`      Treasury: ${treasury}`);
      console.log(`      Paused: ${paused}`);

      expect(owner).to.not.equal(ethers.ZeroAddress);
      expect(treasury).to.not.equal(ethers.ZeroAddress);
      expect(paused).to.equal(false);
    });

    it("ConfidentialUSDC rate is 1 (1:1 USDC:cUSDC)", async function () {
      const rate = await cUSDC.rate();
      console.log(`      Rate: ${rate}`);
      expect(rate).to.equal(1n);
    });
  });

  // ===========================================================================
  // 2. MockUSDC Operations
  // ===========================================================================

  describe("2. MockUSDC Balances", function () {
    it("reads USDC balance of signer", async function () {
      const balance = await usdc.balanceOf(signerAddress);
      console.log(`      USDC Balance: ${ethers.formatUnits(balance, 6)} USDC`);
      // Balance could be anything, just verify it returns
      expect(balance).to.be.a("bigint");
    });
  });

  // ===========================================================================
  // 3. Wrap USDC → cUSDC (Real On-Chain)
  // ===========================================================================

  describe("3. Wrap USDC → cUSDC", function () {
    const WRAP_AMOUNT = 100_000n; // 0.10 USDC

    it("mints MockUSDC if balance is low", async function () {
      const balance = await usdc.balanceOf(signerAddress);

      if (balance < WRAP_AMOUNT * 2n) {
        console.log(`      Minting 10 USDC...`);
        const tx = await usdc.mint(signerAddress, 10_000_000n);
        await tx.wait();
        const newBalance = await usdc.balanceOf(signerAddress);
        console.log(`      New balance: ${ethers.formatUnits(newBalance, 6)} USDC`);
      } else {
        console.log(`      Balance sufficient: ${ethers.formatUnits(balance, 6)} USDC`);
      }
    });

    it("approves ConfidentialUSDC to spend USDC", async function () {
      const tx = await usdc.approve(CONFIDENTIAL_USDC_ADDRESS, WRAP_AMOUNT);
      const receipt = await tx.wait();

      console.log(`      Approve TX: ${receipt.hash}`);
      expect(receipt.status).to.equal(1);
    });

    it("wraps USDC into cUSDC", async function () {
      const feesBefore = await cUSDC.accumulatedFees();

      const tx = await cUSDC.wrap(signerAddress, WRAP_AMOUNT);
      const receipt = await tx.wait();

      console.log(`      Wrap TX: ${receipt.hash}`);
      console.log(`      Gas used: ${receipt.gasUsed.toString()}`);
      expect(receipt.status).to.equal(1);

      // Verify fee was accumulated
      const feesAfter = await cUSDC.accumulatedFees();
      const feeDelta = feesAfter - feesBefore;
      console.log(`      Fee accumulated: ${ethers.formatUnits(feeDelta, 6)} USDC`);

      // Min fee is 0.01 USDC = 10000 raw
      expect(feeDelta).to.be.gte(10_000n);
    });

    it("signer has encrypted balance after wrap", async function () {
      const handle = await cUSDC.confidentialBalanceOf(signerAddress);
      const zeroHandle = "0x" + "00".repeat(32);

      console.log(`      Encrypted balance handle: ${handle}`);

      // After wrapping, the encrypted balance should be non-zero
      expect(handle).to.not.equal(zeroHandle);
    });
  });

  // ===========================================================================
  // 4. X402PaymentVerifier — recordPayment (Real On-Chain)
  // ===========================================================================

  describe("4. recordPayment on Verifier", function () {
    let testNonce: string;

    it("records a payment with unique nonce", async function () {
      testNonce = ethers.hexlify(ethers.randomBytes(32));
      const server = signerAddress; // use self as server for test
      const minPrice = 50_000n; // 0.05 USDC

      const tx = await verifier.recordPayment(server, testNonce, minPrice);
      const receipt = await tx.wait();

      console.log(`      recordPayment TX: ${receipt.hash}`);
      console.log(`      Gas used: ${receipt.gasUsed.toString()}`);
      console.log(`      Nonce: ${testNonce}`);
      expect(receipt.status).to.equal(1);

      // Verify PaymentVerified event
      const iface = new ethers.Interface(VERIFIER_ABI);
      let found = false;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === "PaymentVerified") {
            console.log(`      Event: PaymentVerified(payer=${parsed.args[0]}, server=${parsed.args[1]}, minPrice=${parsed.args[3]})`);
            expect(parsed.args[0].toLowerCase()).to.equal(signerAddress.toLowerCase());
            found = true;
          }
        } catch { /* skip non-matching logs */ }
      }
      expect(found).to.equal(true, "PaymentVerified event not found");
    });

    it("nonce is marked as used", async function () {
      const used = await verifier.usedNonces(testNonce);
      expect(used).to.equal(true);
    });

    it("rejects duplicate nonce", async function () {
      try {
        const tx = await verifier.recordPayment(signerAddress, testNonce, 50_000n);
        await tx.wait();
        expect.fail("Should have reverted");
      } catch (e: any) {
        console.log(`      Correctly reverted: ${e.message.slice(0, 80)}...`);
        // Sepolia RPC may not include custom error name, just "execution reverted"
        expect(
          e.message.includes("NonceAlreadyUsed") || e.message.includes("execution reverted")
        ).to.equal(true);
      }
    });
  });

  // ===========================================================================
  // 5. recordBatchPayment (Real On-Chain)
  // ===========================================================================

  describe("5. recordBatchPayment on Verifier", function () {
    it("records a batch payment with unique nonce", async function () {
      const batchNonce = ethers.hexlify(ethers.randomBytes(32));
      const server = signerAddress;
      const requestCount = 10;
      const pricePerRequest = 100_000n; // 0.10 USDC each

      const tx = await verifier.recordBatchPayment(
        server,
        batchNonce,
        requestCount,
        pricePerRequest
      );
      const receipt = await tx.wait();

      console.log(`      recordBatchPayment TX: ${receipt.hash}`);
      console.log(`      Gas used: ${receipt.gasUsed.toString()}`);
      console.log(`      Requests: ${requestCount}, Price: ${ethers.formatUnits(pricePerRequest, 6)} USDC each`);
      expect(receipt.status).to.equal(1);

      // Verify BatchPaymentRecorded event
      const iface = new ethers.Interface(VERIFIER_ABI);
      let found = false;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === "BatchPaymentRecorded") {
            console.log(`      Event: BatchPaymentRecorded(requestCount=${parsed.args[3]}, pricePerRequest=${parsed.args[4]})`);
            expect(Number(parsed.args[3])).to.equal(requestCount);
            expect(parsed.args[4]).to.equal(pricePerRequest);
            found = true;
          }
        } catch { /* skip non-matching logs */ }
      }
      expect(found).to.equal(true, "BatchPaymentRecorded event not found");

      // Verify nonce is used
      const used = await verifier.usedNonces(batchNonce);
      expect(used).to.equal(true);
    });
  });

  // ===========================================================================
  // 6. ERC-7984 Operator Tests (Real On-Chain)
  // ===========================================================================

  describe("6. ERC-7984 Operator", function () {
    it("setOperator grants operator role to verifier", async function () {
      // Set verifier as operator with far-future expiry
      const farFuture = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60; // 1 year
      const tx = await cUSDC.setOperator(X402_VERIFIER_ADDRESS, farFuture);
      const receipt = await tx.wait();

      console.log(`      setOperator TX: ${receipt.hash}`);
      console.log(`      Gas used: ${receipt.gasUsed.toString()}`);
      expect(receipt.status).to.equal(1);
    });

    it("isOperator returns true for verifier", async function () {
      const isOp = await cUSDC.isOperator(signerAddress, X402_VERIFIER_ADDRESS);
      console.log(`      isOperator(signer, verifier): ${isOp}`);
      expect(isOp).to.equal(true);
    });

    it("isOperator returns true for self", async function () {
      const isOp = await cUSDC.isOperator(signerAddress, signerAddress);
      expect(isOp).to.equal(true);
    });

    it("isOperator returns false for random address", async function () {
      const random = ethers.Wallet.createRandom().address;
      const isOp = await cUSDC.isOperator(signerAddress, random);
      expect(isOp).to.equal(false);
    });
  });

  // ===========================================================================
  // 7. Gas Cost Report
  // ===========================================================================

  describe("7. Gas Cost Summary", function () {
    it("reports gas costs for key operations", async function () {
      // Run one more wrap to measure gas accurately
      const balance = await usdc.balanceOf(signerAddress);
      if (balance < 100_000n) {
        const mintTx = await usdc.mint(signerAddress, 10_000_000n);
        await mintTx.wait();
      }

      // Measure approve
      const approveTx = await usdc.approve(CONFIDENTIAL_USDC_ADDRESS, 100_000n);
      const approveReceipt = await approveTx.wait();

      // Measure wrap
      const wrapTx = await cUSDC.wrap(signerAddress, 100_000n);
      const wrapReceipt = await wrapTx.wait();

      // Measure recordPayment
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const rpTx = await verifier.recordPayment(signerAddress, nonce, 50_000n);
      const rpReceipt = await rpTx.wait();

      // Measure recordBatchPayment
      const batchNonce = ethers.hexlify(ethers.randomBytes(32));
      const bpTx = await verifier.recordBatchPayment(signerAddress, batchNonce, 10, 100_000n);
      const bpReceipt = await bpTx.wait();

      console.log(`\n      ┌─────────────────────────┬──────────────┐`);
      console.log(`      │ Operation               │ Gas Used     │`);
      console.log(`      ├─────────────────────────┼──────────────┤`);
      console.log(`      │ USDC approve            │ ${approveReceipt.gasUsed.toString().padStart(12)} │`);
      console.log(`      │ cUSDC wrap              │ ${wrapReceipt.gasUsed.toString().padStart(12)} │`);
      console.log(`      │ recordPayment           │ ${rpReceipt.gasUsed.toString().padStart(12)} │`);
      console.log(`      │ recordBatchPayment      │ ${bpReceipt.gasUsed.toString().padStart(12)} │`);
      console.log(`      └─────────────────────────┴──────────────┘`);
    });
  });
});
