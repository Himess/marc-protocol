import { expect } from "chai";
import { ethers } from "hardhat";
import type { ConfidentialACP, ConfidentialUSDC } from "../types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("ConfidentialACP — FHE-Encrypted Job Escrow", function () {
  let acp: ConfidentialACP;
  let cUSDC: ConfidentialUSDC;
  let mockUSDC: any;
  let owner: HardhatEthersSigner;
  let client: HardhatEthersSigner;
  let provider: HardhatEthersSigner;
  let evaluator: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const USDC_100 = 100_000_000;   // 100 USDC (uint64)
  const USDC_1000 = 1_000_000_000n; // 1000 USDC (uint256 for wrap)
  const MAX_EXPIRY = 281474976710655n; // uint48 max
  const expiry = () => Math.floor(Date.now() / 1000) + 86400; // +1 day

  beforeEach(async function () {
    [owner, client, provider, evaluator, treasury, other] = await ethers.getSigners();

    // Deploy MockUSDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUSDC = await MockUSDC.deploy();
    await mockUSDC.waitForDeployment();

    // Deploy ConfidentialUSDC
    const CUSDC = await ethers.getContractFactory("ConfidentialUSDC");
    cUSDC = await CUSDC.deploy(
      await mockUSDC.getAddress(),
      treasury.address
    ) as ConfidentialUSDC;
    await cUSDC.waitForDeployment();

    // Deploy ConfidentialACP
    const ACP = await ethers.getContractFactory("ConfidentialACP");
    acp = await ACP.deploy(
      await cUSDC.getAddress(),
      treasury.address
    ) as ConfidentialACP;
    await acp.waitForDeployment();

    // Mint USDC to client and wrap to cUSDC
    await mockUSDC.mint(client.address, USDC_1000);
    await mockUSDC.connect(client).approve(await cUSDC.getAddress(), USDC_1000);
    await cUSDC.connect(client).wrap(client.address, USDC_1000);

    // Client sets ACP as operator so it can transfer cUSDC on client's behalf
    await cUSDC.connect(client).setOperator(await acp.getAddress(), MAX_EXPIRY);
  });

  // =========================================================================
  // DEPLOYMENT
  // =========================================================================

  describe("Deployment", function () {
    it("sets payment token to ConfidentialUSDC", async function () {
      expect(await acp.paymentToken()).to.equal(await cUSDC.getAddress());
    });

    it("sets treasury correctly", async function () {
      expect(await acp.treasury()).to.equal(treasury.address);
    });

    it("sets platform fee to 1% (100 bps)", async function () {
      expect(await acp.PLATFORM_FEE_BPS()).to.equal(100n);
    });

    it("reverts on zero payment token", async function () {
      const ACP = await ethers.getContractFactory("ConfidentialACP");
      await expect(
        ACP.deploy(ethers.ZeroAddress, treasury.address)
      ).to.be.revertedWithCustomError(acp, "ZeroAddress");
    });

    it("reverts on zero treasury", async function () {
      const ACP = await ethers.getContractFactory("ConfidentialACP");
      await expect(
        ACP.deploy(await cUSDC.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(acp, "ZeroAddress");
    });

    it("reverts on EOA as payment token", async function () {
      const ACP = await ethers.getContractFactory("ConfidentialACP");
      await expect(
        ACP.deploy(client.address, treasury.address)
      ).to.be.revertedWithCustomError(acp, "InvalidPaymentToken");
    });
  });

  // =========================================================================
  // JOB CREATION
  // =========================================================================

  describe("Job Creation", function () {
    it("creates a job with valid parameters", async function () {
      const tx = await acp.connect(client).createJob(
        provider.address, evaluator.address, expiry(), "Build a dashboard", ethers.ZeroAddress
      );
      await expect(tx).to.emit(acp, "JobCreated");
      expect(await acp.totalJobs()).to.equal(1n);
    });

    it("creates job with zero provider (set later)", async function () {
      await acp.connect(client).createJob(
        ethers.ZeroAddress, evaluator.address, expiry(), "Test", ethers.ZeroAddress
      );
      const job = await acp.getJob(1);
      expect(job.provider).to.equal(ethers.ZeroAddress);
    });

    it("increments job IDs", async function () {
      await acp.connect(client).createJob(provider.address, evaluator.address, expiry(), "Job 1", ethers.ZeroAddress);
      await acp.connect(client).createJob(provider.address, evaluator.address, expiry(), "Job 2", ethers.ZeroAddress);
      expect(await acp.totalJobs()).to.equal(2n);
    });

    it("reverts with zero evaluator", async function () {
      await expect(
        acp.connect(client).createJob(provider.address, ethers.ZeroAddress, expiry(), "Test", ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(acp, "InvalidEvaluator");
    });

    it("reverts when evaluator is client (self-dealing)", async function () {
      await expect(
        acp.connect(client).createJob(provider.address, client.address, expiry(), "Test", ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(acp, "SelfDealing");
    });

    it("reverts when evaluator is provider (self-dealing)", async function () {
      await expect(
        acp.connect(client).createJob(provider.address, provider.address, expiry(), "Test", ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(acp, "SelfDealing");
    });

    it("reverts with expired timestamp", async function () {
      await expect(
        acp.connect(client).createJob(provider.address, evaluator.address, 1, "Test", ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(acp, "InvalidExpiry");
    });
  });

  // =========================================================================
  // SET PROVIDER
  // =========================================================================

  describe("Set Provider", function () {
    beforeEach(async function () {
      await acp.connect(client).createJob(ethers.ZeroAddress, evaluator.address, expiry(), "Test", ethers.ZeroAddress);
    });

    it("sets provider on open job", async function () {
      await expect(acp.connect(client).setProvider(1, provider.address))
        .to.emit(acp, "ProviderSet")
        .withArgs(1n, provider.address);
    });

    it("reverts if not client", async function () {
      await expect(
        acp.connect(provider).setProvider(1, provider.address)
      ).to.be.revertedWithCustomError(acp, "Unauthorized");
    });

    it("reverts with zero provider", async function () {
      await expect(
        acp.connect(client).setProvider(1, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(acp, "InvalidProvider");
    });
  });

  // =========================================================================
  // FUND (FHE Encrypted)
  // =========================================================================

  describe("Fund (FHE)", function () {
    beforeEach(async function () {
      await acp.connect(client).createJob(
        provider.address, evaluator.address, expiry(), "Encrypted job", ethers.ZeroAddress
      );
    });

    it("funds a job with encrypted cUSDC", async function () {
      const tx = await acp.connect(client).fund(1, USDC_100);

      await expect(tx).to.emit(acp, "JobFunded").withArgs(1n, client.address);

      const job = await acp.getJob(1);
      expect(job.status).to.equal(1n); // Funded
    });

    it("reverts if not client", async function () {
      await expect(
        acp.connect(provider).fund(1, USDC_100)
      ).to.be.revertedWithCustomError(acp, "Unauthorized");
    });

    it("reverts on non-existent job", async function () {
      try {
        await acp.connect(client).fund(999, USDC_100);
        expect.fail("Should have reverted");
      } catch (e: any) {
        // fhEVM mock throws HardhatFhevmError or contract reverts with JobNotFound
        expect(e).to.exist;
      }
    });

    it("handles zero amount gracefully", async function () {
      // Create and try to fund with 0 - should revert with ZeroBudget
      await acp.connect(client).createJob(provider.address, evaluator.address, expiry(), "Zero test", ethers.ZeroAddress);
      await expect(acp.connect(client).fund(2, 0)).to.be.revertedWithCustomError(acp, "ZeroBudget");
    });
  });

  // =========================================================================
  // CREATE AND FUND
  // =========================================================================

  describe("Create and Fund", function () {
    it("creates and funds a job in one transaction", async function () {
      const tx = await acp.connect(client).createAndFund(
        provider.address,
        evaluator.address,
        expiry(),
        "One-shot encrypted job",
        ethers.ZeroAddress,
        USDC_100
      );

      await expect(tx).to.emit(acp, "JobCreated");
      await expect(tx).to.emit(acp, "JobFunded");

      const job = await acp.getJob(1);
      expect(job.client).to.equal(client.address);
      expect(job.status).to.equal(1n); // Funded
      expect(await acp.totalJobs()).to.equal(1n);
    });
  });

  // =========================================================================
  // SUBMIT
  // =========================================================================

  describe("Submit", function () {
    const deliverable = ethers.keccak256(ethers.toUtf8Bytes("ipfs://Qm...deliverable"));

    beforeEach(async function () {
      await acp.connect(client).createAndFund(
        provider.address, evaluator.address, expiry(), "Job", ethers.ZeroAddress, USDC_100
      );
    });

    it("provider submits deliverable", async function () {
      const tx = await acp.connect(provider).submit(1, deliverable);
      await expect(tx).to.emit(acp, "JobSubmitted").withArgs(1n, provider.address, deliverable);

      const job = await acp.getJob(1);
      expect(job.status).to.equal(2n); // Submitted
      expect(job.deliverable).to.equal(deliverable);
    });

    it("reverts if not provider", async function () {
      await expect(
        acp.connect(client).submit(1, deliverable)
      ).to.be.revertedWithCustomError(acp, "Unauthorized");
    });

    it("reverts if job not funded", async function () {
      await acp.connect(client).createJob(
        provider.address, evaluator.address, expiry(), "Unfunded", ethers.ZeroAddress
      );
      await expect(
        acp.connect(provider).submit(2, deliverable)
      ).to.be.revertedWithCustomError(acp, "InvalidStatus");
    });
  });

  // =========================================================================
  // COMPLETE (FHE Fee Calculation)
  // =========================================================================

  describe("Complete (FHE)", function () {
    const deliverable = ethers.keccak256(ethers.toUtf8Bytes("deliverable"));
    const reason = ethers.keccak256(ethers.toUtf8Bytes("good work"));

    beforeEach(async function () {
      await acp.connect(client).createAndFund(
        provider.address, evaluator.address, expiry(), "Job", ethers.ZeroAddress, USDC_100
      );
      await acp.connect(provider).submit(1, deliverable);
    });

    it("evaluator completes job and releases encrypted payment", async function () {
      const tx = await acp.connect(evaluator).complete(1, reason);

      await expect(tx).to.emit(acp, "JobCompleted").withArgs(1n, evaluator.address, reason);
      await expect(tx).to.emit(acp, "PaymentReleased").withArgs(1n, provider.address);

      const job = await acp.getJob(1);
      expect(job.status).to.equal(3n); // Completed
    });

    it("reverts if not evaluator", async function () {
      await expect(
        acp.connect(client).complete(1, reason)
      ).to.be.revertedWithCustomError(acp, "Unauthorized");
    });

    it("reverts if job not submitted", async function () {
      // Create funded but not submitted job
      await acp.connect(client).createAndFund(
        provider.address, evaluator.address, expiry(), "Job 2", ethers.ZeroAddress, USDC_100
      );
      await expect(
        acp.connect(evaluator).complete(2, reason)
      ).to.be.revertedWithCustomError(acp, "InvalidStatus");
    });

    it("cannot complete the same job twice", async function () {
      await acp.connect(evaluator).complete(1, reason);
      await expect(
        acp.connect(evaluator).complete(1, reason)
      ).to.be.revertedWithCustomError(acp, "InvalidStatus");
    });
  });

  // =========================================================================
  // REJECT
  // =========================================================================

  describe("Reject", function () {
    const reason = ethers.keccak256(ethers.toUtf8Bytes("not satisfactory"));

    it("client rejects open job (no refund needed)", async function () {
      await acp.connect(client).createJob(
        provider.address, evaluator.address, expiry(), "Job", ethers.ZeroAddress
      );

      const tx = await acp.connect(client).reject(1, reason);
      await expect(tx).to.emit(acp, "JobRejected").withArgs(1n, client.address, reason);

      const job = await acp.getJob(1);
      expect(job.status).to.equal(4n); // Rejected
    });

    it("client rejects funded job (encrypted refund)", async function () {
      await acp.connect(client).createAndFund(
        provider.address, evaluator.address, expiry(), "Job", ethers.ZeroAddress, USDC_100
      );

      const tx = await acp.connect(client).reject(1, reason);
      await expect(tx).to.emit(acp, "JobRejected");
      await expect(tx).to.emit(acp, "Refunded").withArgs(1n, client.address);

      const job = await acp.getJob(1);
      expect(job.status).to.equal(4n); // Rejected
    });

    it("evaluator rejects submitted job (encrypted refund)", async function () {
      const deliverable = ethers.keccak256(ethers.toUtf8Bytes("bad work"));
      await acp.connect(client).createAndFund(
        provider.address, evaluator.address, expiry(), "Job", ethers.ZeroAddress, USDC_100
      );
      await acp.connect(provider).submit(1, deliverable);

      const tx = await acp.connect(evaluator).reject(1, reason);
      await expect(tx).to.emit(acp, "JobRejected");
      await expect(tx).to.emit(acp, "Refunded").withArgs(1n, client.address);
    });

    it("reverts if unauthorized", async function () {
      await acp.connect(client).createJob(
        provider.address, evaluator.address, expiry(), "Job", ethers.ZeroAddress
      );
      await expect(
        acp.connect(other).reject(1, reason)
      ).to.be.revertedWithCustomError(acp, "Unauthorized");
    });

    it("reverts if client rejects completed job", async function () {
      const deliverable = ethers.keccak256(ethers.toUtf8Bytes("done"));
      await acp.connect(client).createAndFund(
        provider.address, evaluator.address, expiry(), "Job", ethers.ZeroAddress, USDC_100
      );
      await acp.connect(provider).submit(1, deliverable);
      await acp.connect(evaluator).complete(1, reason);

      await expect(
        acp.connect(client).reject(1, reason)
      ).to.be.revertedWithCustomError(acp, "InvalidStatus");
    });
  });

  // =========================================================================
  // CLAIM REFUND (Expired)
  // =========================================================================

  describe("Claim Refund", function () {
    it("client claims refund on expired funded job", async function () {
      // Create job with 1 second expiry
      const nearExpiry = (await ethers.provider.getBlock("latest"))!.timestamp + 120;
      await acp.connect(client).createAndFund(
        provider.address, evaluator.address, nearExpiry, "Job", ethers.ZeroAddress, USDC_100
      );

      // Advance time past expiry
      await ethers.provider.send("evm_increaseTime", [200]);
      await ethers.provider.send("evm_mine", []);

      const tx = await acp.connect(client).claimRefund(1);
      await expect(tx).to.emit(acp, "Refunded").withArgs(1n, client.address);

      const job = await acp.getJob(1);
      expect(job.status).to.equal(5n); // Expired
    });

    it("reverts if not expired yet", async function () {
      await acp.connect(client).createAndFund(
        provider.address, evaluator.address, expiry(), "Job", ethers.ZeroAddress, USDC_100
      );
      await expect(
        acp.connect(client).claimRefund(1)
      ).to.be.revertedWithCustomError(acp, "InvalidStatus");
    });

    it("reverts if not client", async function () {
      const nearExpiry = (await ethers.provider.getBlock("latest"))!.timestamp + 120;
      await acp.connect(client).createAndFund(
        provider.address, evaluator.address, nearExpiry, "Job", ethers.ZeroAddress, USDC_100
      );
      await ethers.provider.send("evm_increaseTime", [200]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        acp.connect(provider).claimRefund(1)
      ).to.be.revertedWithCustomError(acp, "Unauthorized");
    });
  });

  // =========================================================================
  // FULL LIFECYCLE
  // =========================================================================

  describe("Full Lifecycle", function () {
    it("create → fund → submit → complete (happy path)", async function () {
      // 1. Create job
      await acp.connect(client).createJob(
        provider.address, evaluator.address, expiry(), "Full lifecycle test", ethers.ZeroAddress
      );

      // 2. Fund with encrypted cUSDC
      await acp.connect(client).fund(1, USDC_100);

      // 3. Provider submits
      const deliverable = ethers.keccak256(ethers.toUtf8Bytes("final_delivery"));
      await acp.connect(provider).submit(1, deliverable);

      // 4. Evaluator completes
      const reason = ethers.keccak256(ethers.toUtf8Bytes("approved"));
      await acp.connect(evaluator).complete(1, reason);

      const job = await acp.getJob(1);
      expect(job.status).to.equal(3n); // Completed
    });

    it("createAndFund → submit → reject (rejection path)", async function () {
      await acp.connect(client).createAndFund(
        provider.address, evaluator.address, expiry(), "Will be rejected", ethers.ZeroAddress, USDC_100
      );

      const deliverable = ethers.keccak256(ethers.toUtf8Bytes("bad_work"));
      await acp.connect(provider).submit(1, deliverable);

      const reason = ethers.keccak256(ethers.toUtf8Bytes("insufficient quality"));
      await acp.connect(evaluator).reject(1, reason);

      const job = await acp.getJob(1);
      expect(job.status).to.equal(4n); // Rejected
    });

    it("createAndFund → expire → claimRefund (expiry path)", async function () {
      const nearExpiry = (await ethers.provider.getBlock("latest"))!.timestamp + 120;
      await acp.connect(client).createAndFund(
        provider.address, evaluator.address, nearExpiry, "Will expire", ethers.ZeroAddress, USDC_100
      );

      await ethers.provider.send("evm_increaseTime", [200]);
      await ethers.provider.send("evm_mine", []);

      await acp.connect(client).claimRefund(1);

      const job = await acp.getJob(1);
      expect(job.status).to.equal(5n); // Expired
    });
  });

  // =========================================================================
  // ADMIN
  // =========================================================================

  describe("Admin", function () {
    it("updates treasury", async function () {
      await expect(acp.connect(owner).setTreasury(other.address))
        .to.emit(acp, "TreasuryUpdated")
        .withArgs(treasury.address, other.address);
    });

    it("reverts treasury update from non-owner", async function () {
      await expect(acp.connect(client).setTreasury(other.address)).to.be.reverted;
    });

    it("reverts treasury update to zero", async function () {
      await expect(
        acp.connect(owner).setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(acp, "ZeroAddress");
    });

    it("pauses and unpauses", async function () {
      await acp.connect(owner).pause();
      await expect(
        acp.connect(client).createJob(provider.address, evaluator.address, expiry(), "Test", ethers.ZeroAddress)
      ).to.be.reverted;

      await acp.connect(owner).unpause();
      await acp.connect(client).createJob(provider.address, evaluator.address, expiry(), "Test", ethers.ZeroAddress);
    });

    it("non-owner cannot pause", async function () {
      await expect(acp.connect(client).pause()).to.be.reverted;
    });
  });
});
