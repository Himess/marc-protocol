import { expect } from "chai";
import { ethers } from "hardhat";

describe("AgenticCommerceProtocol", function () {
  let acp: any;
  let usdc: any;
  let owner: any;
  let client: any;
  let provider: any;
  let evaluator: any;
  let treasury: any;
  let other: any;

  const ONE_USDC = 1_000_000n; // 6 decimals
  const JOB_BUDGET = 100n * ONE_USDC; // 100 USDC
  const PLATFORM_FEE_BPS = 100n;
  const BPS_DENOM = 10_000n;

  // Default expiry: 1 hour from latest block
  async function futureExpiry(seconds = 3600): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return block!.timestamp + seconds;
  }

  // Helper: create a standard job and return its ID
  async function createDefaultJob(hook = ethers.ZeroAddress): Promise<bigint> {
    const expiry = await futureExpiry();
    const tx = await acp
      .connect(client)
      .createJob(provider.address, evaluator.address, expiry, "Test job", hook);
    const receipt = await tx.wait();
    // Job IDs start at 1
    const event = receipt.logs.find(
      (l: any) => l.fragment?.name === "JobCreated"
    );
    return event ? event.args[0] : 1n;
  }

  // Helper: create + setBudget + fund
  async function createAndFundJob(budget = JOB_BUDGET): Promise<bigint> {
    const jobId = await createDefaultJob();
    await acp.connect(client).setBudget(jobId, budget);
    await usdc.connect(client).approve(await acp.getAddress(), budget);
    await acp.connect(client).fund(jobId, budget);
    return jobId;
  }

  beforeEach(async function () {
    [owner, client, provider, evaluator, treasury, other] =
      await ethers.getSigners();

    // Deploy MockUSDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    // Deploy ACP
    const ACP = await ethers.getContractFactory("AgenticCommerceProtocol");
    acp = await ACP.deploy(await usdc.getAddress(), treasury.address);
    await acp.waitForDeployment();

    // Mint USDC to client
    await usdc.mint(client.address, JOB_BUDGET * 10n);

    // Approve ACP to spend client's USDC
    await usdc
      .connect(client)
      .approve(await acp.getAddress(), JOB_BUDGET * 10n);
  });

  // =========================================================================
  // DEPLOYMENT
  // =========================================================================

  describe("Deployment", function () {
    it("sets paymentToken to USDC address", async function () {
      expect(await acp.paymentToken()).to.equal(await usdc.getAddress());
    });

    it("sets treasury to provided address", async function () {
      expect(await acp.treasury()).to.equal(treasury.address);
    });

    it("sets owner to deployer", async function () {
      expect(await acp.owner()).to.equal(owner.address);
    });

    it("reverts if paymentToken is zero address", async function () {
      const ACP = await ethers.getContractFactory("AgenticCommerceProtocol");
      await expect(
        ACP.deploy(ethers.ZeroAddress, treasury.address)
      ).to.be.revertedWithCustomError(acp, "ZeroAddress");
    });

    it("reverts if treasury is zero address", async function () {
      const ACP = await ethers.getContractFactory("AgenticCommerceProtocol");
      await expect(
        ACP.deploy(await usdc.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(acp, "ZeroAddress");
    });

    it("emits TreasuryUpdated on deployment", async function () {
      const ACP = await ethers.getContractFactory("AgenticCommerceProtocol");
      const newAcp = await ACP.deploy(await usdc.getAddress(), treasury.address);
      const tx = newAcp.deploymentTransaction();
      await expect(tx)
        .to.emit(newAcp, "TreasuryUpdated")
        .withArgs(ethers.ZeroAddress, treasury.address);
    });
  });

  // =========================================================================
  // createJob
  // =========================================================================

  describe("createJob", function () {
    it("creates job with correct fields", async function () {
      const expiry = await futureExpiry();
      const tx = await acp
        .connect(client)
        .createJob(
          provider.address,
          evaluator.address,
          expiry,
          "Analyze dataset",
          ethers.ZeroAddress
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l: any) => l.fragment?.name === "JobCreated"
      );
      const jobId = event.args[0];

      const job = await acp.getJob(jobId);
      expect(job.client).to.equal(client.address);
      expect(job.provider).to.equal(provider.address);
      expect(job.evaluator).to.equal(evaluator.address);
      expect(job.expiredAt).to.equal(expiry);
      expect(job.description).to.equal("Analyze dataset");
      expect(job.status).to.equal(0); // JobStatus.Open
      expect(job.budget).to.equal(0n);
    });

    it("emits JobCreated event", async function () {
      const expiry = await futureExpiry();
      await expect(
        acp
          .connect(client)
          .createJob(
            provider.address,
            evaluator.address,
            expiry,
            "Test",
            ethers.ZeroAddress
          )
      )
        .to.emit(acp, "JobCreated")
        .withArgs(1, client.address, provider.address, evaluator.address, expiry);
    });

    it("auto-increments jobId", async function () {
      const expiry = await futureExpiry();
      await acp
        .connect(client)
        .createJob(
          provider.address,
          evaluator.address,
          expiry,
          "Job 1",
          ethers.ZeroAddress
        );
      await acp
        .connect(client)
        .createJob(
          provider.address,
          evaluator.address,
          expiry,
          "Job 2",
          ethers.ZeroAddress
        );

      const job1 = await acp.getJob(1);
      const job2 = await acp.getJob(2);
      expect(job1.description).to.equal("Job 1");
      expect(job2.description).to.equal("Job 2");
    });

    it("allows zero provider (set later)", async function () {
      const expiry = await futureExpiry();
      const tx = await acp
        .connect(client)
        .createJob(
          ethers.ZeroAddress,
          evaluator.address,
          expiry,
          "Open job",
          ethers.ZeroAddress
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l: any) => l.fragment?.name === "JobCreated"
      );
      const jobId = event.args[0];

      const job = await acp.getJob(jobId);
      expect(job.provider).to.equal(ethers.ZeroAddress);
    });

    it("reverts if evaluator is zero address", async function () {
      const expiry = await futureExpiry();
      await expect(
        acp
          .connect(client)
          .createJob(
            provider.address,
            ethers.ZeroAddress,
            expiry,
            "Bad",
            ethers.ZeroAddress
          )
      ).to.be.revertedWithCustomError(acp, "InvalidEvaluator");
    });

    it("reverts if evaluator is the client (self-dealing)", async function () {
      const expiry = await futureExpiry();
      await expect(
        acp
          .connect(client)
          .createJob(
            provider.address,
            client.address, // client == evaluator
            expiry,
            "Self-deal",
            ethers.ZeroAddress
          )
      ).to.be.revertedWithCustomError(acp, "SelfDealing");
    });

    it("reverts when evaluator equals provider (collusion prevention)", async function () {
      const expiry = await futureExpiry();
      await expect(
        acp
          .connect(client)
          .createJob(
            provider.address,
            provider.address, // evaluator == provider
            expiry,
            "Test job",
            ethers.ZeroAddress
          )
      ).to.be.revertedWithCustomError(acp, "SelfDealing");
    });

    it("reverts if expiry is in the past", async function () {
      const block = await ethers.provider.getBlock("latest");
      const pastExpiry = block!.timestamp - 1;
      await expect(
        acp
          .connect(client)
          .createJob(
            provider.address,
            evaluator.address,
            pastExpiry,
            "Bad",
            ethers.ZeroAddress
          )
      ).to.be.revertedWithCustomError(acp, "InvalidExpiry");
    });
  });

  // =========================================================================
  // setProvider
  // =========================================================================

  describe("setProvider", function () {
    it("client can set provider", async function () {
      const jobId = await createDefaultJob();
      await acp.connect(client).setProvider(jobId, other.address);

      const job = await acp.getJob(jobId);
      expect(job.provider).to.equal(other.address);
    });

    it("reverts if caller is not client", async function () {
      const jobId = await createDefaultJob();
      await expect(
        acp.connect(other).setProvider(jobId, other.address)
      ).to.be.revertedWithCustomError(acp, "Unauthorized");
    });

    it("reverts if job is not Open", async function () {
      const jobId = await createAndFundJob();
      await expect(
        acp.connect(client).setProvider(jobId, other.address)
      ).to.be.revertedWithCustomError(acp, "InvalidStatus");
    });

    it("reverts if provider is zero address", async function () {
      const jobId = await createDefaultJob();
      await expect(
        acp.connect(client).setProvider(jobId, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(acp, "InvalidProvider");
    });
  });

  // =========================================================================
  // setBudget
  // =========================================================================

  describe("setBudget", function () {
    it("client can set budget", async function () {
      const jobId = await createDefaultJob();
      await acp.connect(client).setBudget(jobId, JOB_BUDGET);

      const job = await acp.getJob(jobId);
      expect(job.budget).to.equal(JOB_BUDGET);
    });

    it("setBudget reverts when called by provider", async function () {
      const jobId = await createDefaultJob();
      await expect(
        acp.connect(provider).setBudget(jobId, JOB_BUDGET)
      ).to.be.revertedWithCustomError(acp, "Unauthorized");
    });

    it("reverts if caller is neither client nor provider", async function () {
      const jobId = await createDefaultJob();
      await expect(
        acp.connect(other).setBudget(jobId, JOB_BUDGET)
      ).to.be.revertedWithCustomError(acp, "Unauthorized");
    });

    it("reverts if job is not Open", async function () {
      const jobId = await createAndFundJob();
      await expect(
        acp.connect(client).setBudget(jobId, JOB_BUDGET * 2n)
      ).to.be.revertedWithCustomError(acp, "InvalidStatus");
    });

    it("reverts on zero budget", async function () {
      const jobId = await createDefaultJob();
      await expect(
        acp.connect(client).setBudget(jobId, 0)
      ).to.be.revertedWithCustomError(acp, "ZeroBudget");
    });
  });

  // =========================================================================
  // fund
  // =========================================================================

  describe("fund", function () {
    it("funds job and transfers tokens to contract", async function () {
      const jobId = await createDefaultJob();
      await acp.connect(client).setBudget(jobId, JOB_BUDGET);

      const balBefore = await usdc.balanceOf(client.address);
      await acp.connect(client).fund(jobId, JOB_BUDGET);
      const balAfter = await usdc.balanceOf(client.address);

      expect(balBefore - balAfter).to.equal(JOB_BUDGET);
      expect(await usdc.balanceOf(await acp.getAddress())).to.equal(JOB_BUDGET);
    });

    it("changes status to Funded", async function () {
      const jobId = await createAndFundJob();
      const job = await acp.getJob(jobId);
      expect(job.status).to.equal(1); // JobStatus.Funded
    });

    it("emits JobFunded event", async function () {
      const jobId = await createDefaultJob();
      await acp.connect(client).setBudget(jobId, JOB_BUDGET);
      await expect(acp.connect(client).fund(jobId, JOB_BUDGET))
        .to.emit(acp, "JobFunded")
        .withArgs(jobId, client.address, JOB_BUDGET);
    });

    it("reverts on budget mismatch", async function () {
      const jobId = await createDefaultJob();
      await acp.connect(client).setBudget(jobId, JOB_BUDGET);
      await expect(
        acp.connect(client).fund(jobId, JOB_BUDGET + 1n)
      ).to.be.revertedWithCustomError(acp, "BudgetMismatch");
    });

    it("reverts if caller is not client", async function () {
      const jobId = await createDefaultJob();
      await acp.connect(client).setBudget(jobId, JOB_BUDGET);
      await expect(
        acp.connect(other).fund(jobId, JOB_BUDGET)
      ).to.be.revertedWithCustomError(acp, "Unauthorized");
    });

    it("reverts if budget is zero (not set)", async function () {
      const jobId = await createDefaultJob();
      // Budget defaults to 0, attempt to fund with expectedBudget = 0
      await expect(
        acp.connect(client).fund(jobId, 0)
      ).to.be.revertedWithCustomError(acp, "ZeroBudget");
    });
  });

  // =========================================================================
  // submit
  // =========================================================================

  describe("submit", function () {
    it("submits deliverable and changes status to Submitted", async function () {
      const jobId = await createAndFundJob();
      const deliverable = ethers.id("deliverable-hash");

      await acp.connect(provider).submit(jobId, deliverable);

      const job = await acp.getJob(jobId);
      expect(job.status).to.equal(2); // JobStatus.Submitted
      expect(job.deliverable).to.equal(deliverable);
    });

    it("emits JobSubmitted event", async function () {
      const jobId = await createAndFundJob();
      const deliverable = ethers.id("deliverable-hash");

      await expect(acp.connect(provider).submit(jobId, deliverable))
        .to.emit(acp, "JobSubmitted")
        .withArgs(jobId, provider.address, deliverable);
    });

    it("reverts if caller is not provider", async function () {
      const jobId = await createAndFundJob();
      const deliverable = ethers.id("deliverable-hash");

      await expect(
        acp.connect(client).submit(jobId, deliverable)
      ).to.be.revertedWithCustomError(acp, "Unauthorized");
    });

    it("reverts if job is not Funded", async function () {
      const jobId = await createDefaultJob();
      const deliverable = ethers.id("deliverable-hash");

      await expect(
        acp.connect(provider).submit(jobId, deliverable)
      ).to.be.revertedWithCustomError(acp, "InvalidStatus");
    });
  });

  // =========================================================================
  // complete
  // =========================================================================

  describe("complete", function () {
    it("completes job and pays provider 99%, treasury 1%", async function () {
      const jobId = await createAndFundJob();
      await acp.connect(provider).submit(jobId, ethers.id("done"));

      const providerBalBefore = await usdc.balanceOf(provider.address);
      const treasuryBalBefore = await usdc.balanceOf(treasury.address);

      await acp.connect(evaluator).complete(jobId, ethers.id("approved"));

      const providerBalAfter = await usdc.balanceOf(provider.address);
      const treasuryBalAfter = await usdc.balanceOf(treasury.address);

      const expectedFee = (JOB_BUDGET * PLATFORM_FEE_BPS) / BPS_DENOM;
      const expectedPayout = JOB_BUDGET - expectedFee;

      expect(providerBalAfter - providerBalBefore).to.equal(expectedPayout);
      expect(treasuryBalAfter - treasuryBalBefore).to.equal(expectedFee);
    });

    it("changes status to Completed", async function () {
      const jobId = await createAndFundJob();
      await acp.connect(provider).submit(jobId, ethers.id("done"));
      await acp.connect(evaluator).complete(jobId, ethers.id("approved"));

      const job = await acp.getJob(jobId);
      expect(job.status).to.equal(3); // JobStatus.Completed
    });

    it("emits JobCompleted and PaymentReleased events", async function () {
      const jobId = await createAndFundJob();
      await acp.connect(provider).submit(jobId, ethers.id("done"));

      const reason = ethers.id("approved");
      const expectedFee = (JOB_BUDGET * PLATFORM_FEE_BPS) / BPS_DENOM;
      const expectedPayout = JOB_BUDGET - expectedFee;

      await expect(acp.connect(evaluator).complete(jobId, reason))
        .to.emit(acp, "JobCompleted")
        .withArgs(jobId, evaluator.address, reason)
        .and.to.emit(acp, "PaymentReleased")
        .withArgs(jobId, provider.address, expectedPayout);
    });

    it("reverts if caller is not evaluator", async function () {
      const jobId = await createAndFundJob();
      await acp.connect(provider).submit(jobId, ethers.id("done"));

      await expect(
        acp.connect(client).complete(jobId, ethers.id("approved"))
      ).to.be.revertedWithCustomError(acp, "Unauthorized");
    });

    it("reverts if job is not Submitted", async function () {
      const jobId = await createAndFundJob();
      // Not submitted yet — still Funded
      await expect(
        acp.connect(evaluator).complete(jobId, ethers.id("approved"))
      ).to.be.revertedWithCustomError(acp, "InvalidStatus");
    });
  });

  // =========================================================================
  // reject
  // =========================================================================

  describe("reject", function () {
    it("client rejects Open job (no refund needed)", async function () {
      const jobId = await createDefaultJob();
      await acp.connect(client).reject(jobId, ethers.id("cancelled"));

      const job = await acp.getJob(jobId);
      expect(job.status).to.equal(4); // JobStatus.Rejected
    });

    it("client rejects Funded job (refunds budget)", async function () {
      const jobId = await createAndFundJob();
      const balBefore = await usdc.balanceOf(client.address);

      await acp.connect(client).reject(jobId, ethers.id("changed-mind"));

      const balAfter = await usdc.balanceOf(client.address);
      expect(balAfter - balBefore).to.equal(JOB_BUDGET);

      const job = await acp.getJob(jobId);
      expect(job.status).to.equal(4); // JobStatus.Rejected
    });

    it("evaluator rejects Submitted job (refunds budget to client)", async function () {
      const jobId = await createAndFundJob();
      await acp.connect(provider).submit(jobId, ethers.id("bad-work"));

      const clientBalBefore = await usdc.balanceOf(client.address);

      await acp.connect(evaluator).reject(jobId, ethers.id("poor-quality"));

      const clientBalAfter = await usdc.balanceOf(client.address);
      expect(clientBalAfter - clientBalBefore).to.equal(JOB_BUDGET);

      const job = await acp.getJob(jobId);
      expect(job.status).to.equal(4); // JobStatus.Rejected
    });

    it("evaluator rejects Funded job (refunds budget to client)", async function () {
      const jobId = await createAndFundJob();
      const clientBalBefore = await usdc.balanceOf(client.address);

      await acp.connect(evaluator).reject(jobId, ethers.id("not-needed"));

      const clientBalAfter = await usdc.balanceOf(client.address);
      expect(clientBalAfter - clientBalBefore).to.equal(JOB_BUDGET);

      const job = await acp.getJob(jobId);
      expect(job.status).to.equal(4); // JobStatus.Rejected
    });

    it("emits JobRejected and Refunded events on Funded reject", async function () {
      const jobId = await createAndFundJob();
      const reason = ethers.id("changed-mind");

      await expect(acp.connect(client).reject(jobId, reason))
        .to.emit(acp, "JobRejected")
        .withArgs(jobId, client.address, reason)
        .and.to.emit(acp, "Refunded")
        .withArgs(jobId, client.address, JOB_BUDGET);
    });

    it("reverts if unauthorized (other cannot reject)", async function () {
      const jobId = await createAndFundJob();
      await expect(
        acp.connect(other).reject(jobId, ethers.id("no"))
      ).to.be.revertedWithCustomError(acp, "Unauthorized");
    });

    it("reverts if job is already Completed", async function () {
      const jobId = await createAndFundJob();
      await acp.connect(provider).submit(jobId, ethers.id("done"));
      await acp.connect(evaluator).complete(jobId, ethers.id("good"));

      await expect(
        acp.connect(client).reject(jobId, ethers.id("too-late"))
      ).to.be.revertedWithCustomError(acp, "InvalidStatus");
    });
  });

  // =========================================================================
  // claimRefund
  // =========================================================================

  describe("claimRefund", function () {
    it("refunds client after expiry for Funded job", async function () {
      // Create job with very short expiry
      const expiry = await futureExpiry(2); // 2 seconds
      const tx = await acp
        .connect(client)
        .createJob(
          provider.address,
          evaluator.address,
          expiry,
          "Expiring job",
          ethers.ZeroAddress
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l: any) => l.fragment?.name === "JobCreated"
      );
      const jobId = event.args[0];

      await acp.connect(client).setBudget(jobId, JOB_BUDGET);
      await acp.connect(client).fund(jobId, JOB_BUDGET);

      // Advance time past expiry
      await ethers.provider.send("evm_increaseTime", [10]);
      await ethers.provider.send("evm_mine", []);

      const balBefore = await usdc.balanceOf(client.address);
      await acp.connect(client).claimRefund(jobId);
      const balAfter = await usdc.balanceOf(client.address);

      expect(balAfter - balBefore).to.equal(JOB_BUDGET);

      const job = await acp.getJob(jobId);
      expect(job.status).to.equal(5); // JobStatus.Expired
    });

    it("reverts before expiry", async function () {
      const jobId = await createAndFundJob(); // default 1 hour expiry
      await expect(
        acp.connect(client).claimRefund(jobId)
      ).to.be.revertedWithCustomError(acp, "InvalidStatus");
    });

    it("works for Submitted job after expiry", async function () {
      const expiry = await futureExpiry(2);
      const tx = await acp
        .connect(client)
        .createJob(
          provider.address,
          evaluator.address,
          expiry,
          "Expiring submitted",
          ethers.ZeroAddress
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l: any) => l.fragment?.name === "JobCreated"
      );
      const jobId = event.args[0];

      await acp.connect(client).setBudget(jobId, JOB_BUDGET);
      await acp.connect(client).fund(jobId, JOB_BUDGET);
      await acp.connect(provider).submit(jobId, ethers.id("work"));

      // Advance time past expiry
      await ethers.provider.send("evm_increaseTime", [10]);
      await ethers.provider.send("evm_mine", []);

      const balBefore = await usdc.balanceOf(client.address);
      await acp.connect(client).claimRefund(jobId);
      const balAfter = await usdc.balanceOf(client.address);

      expect(balAfter - balBefore).to.equal(JOB_BUDGET);
    });

    it("claimRefund succeeds at exact expiry timestamp (block.timestamp >= expiredAt)", async function () {
      // Use a far enough future expiry to avoid timestamp conflicts
      const expiry = await futureExpiry(60); // 60 seconds
      const tx = await acp
        .connect(client)
        .createJob(
          provider.address,
          evaluator.address,
          expiry,
          "Exact expiry test",
          ethers.ZeroAddress
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l: any) => l.fragment?.name === "JobCreated"
      );
      const jobId = event.args[0];

      await acp.connect(client).setBudget(jobId, JOB_BUDGET);
      await acp.connect(client).fund(jobId, JOB_BUDGET);

      // Advance time to exactly expiry
      await ethers.provider.send("evm_increaseTime", [60]);
      await ethers.provider.send("evm_mine", []);

      // block.timestamp >= expiredAt → should succeed
      const balBefore = await usdc.balanceOf(client.address);
      await acp.connect(client).claimRefund(jobId);
      const balAfter = await usdc.balanceOf(client.address);
      expect(balAfter - balBefore).to.equal(JOB_BUDGET);
    });

    it("reverts if job is Open (not funded)", async function () {
      const jobId = await createDefaultJob();

      // Even if expired, Open jobs have no funds to refund
      await ethers.provider.send("evm_increaseTime", [7200]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        acp.connect(client).claimRefund(jobId)
      ).to.be.revertedWithCustomError(acp, "InvalidStatus");
    });

    it("claimRefund reverts when called by non-client", async function () {
      // Create job with very short expiry
      const expiry = await futureExpiry(2); // 2 seconds
      const tx = await acp
        .connect(client)
        .createJob(
          provider.address,
          evaluator.address,
          expiry,
          "Expiring job",
          ethers.ZeroAddress
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l: any) => l.fragment?.name === "JobCreated"
      );
      const jobId = event.args[0];

      await acp.connect(client).setBudget(jobId, JOB_BUDGET);
      await acp.connect(client).fund(jobId, JOB_BUDGET);

      // Advance time past expiry
      await ethers.provider.send("evm_increaseTime", [10]);
      await ethers.provider.send("evm_mine", []);

      // Non-client (provider) tries to claim refund
      await expect(
        acp.connect(provider).claimRefund(jobId)
      ).to.be.revertedWithCustomError(acp, "Unauthorized");

      // Non-client (other) tries to claim refund
      await expect(
        acp.connect(other).claimRefund(jobId)
      ).to.be.revertedWithCustomError(acp, "Unauthorized");
    });
  });

  // =========================================================================
  // setTreasury (admin)
  // =========================================================================

  describe("setTreasury", function () {
    it("owner can set new treasury", async function () {
      await acp.connect(owner).setTreasury(other.address);
      expect(await acp.treasury()).to.equal(other.address);
    });

    it("reverts if caller is not owner", async function () {
      await expect(
        acp.connect(client).setTreasury(other.address)
      ).to.be.revertedWithCustomError(acp, "OwnableUnauthorizedAccount");
    });

    it("reverts if new treasury is zero address", async function () {
      await expect(
        acp.connect(owner).setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(acp, "ZeroAddress");
    });

    it("setTreasury emits TreasuryUpdated event", async function () {
      await expect(acp.connect(owner).setTreasury(other.address))
        .to.emit(acp, "TreasuryUpdated")
        .withArgs(treasury.address, other.address);
    });
  });

  // =========================================================================
  // Pausable (new)
  // =========================================================================

  describe("Pausable", function () {
    it("pause blocks createJob", async function () {
      await acp.connect(owner).pause();
      const expiry = await futureExpiry();
      await expect(
        acp
          .connect(client)
          .createJob(
            provider.address,
            evaluator.address,
            expiry,
            "Test",
            ethers.ZeroAddress
          )
      ).to.be.revertedWithCustomError(acp, "EnforcedPause");
    });

    it("pause blocks fund", async function () {
      // Create and set budget before pausing
      const jobId = await createDefaultJob();
      await acp.connect(client).setBudget(jobId, JOB_BUDGET);

      await acp.connect(owner).pause();

      await expect(
        acp.connect(client).fund(jobId, JOB_BUDGET)
      ).to.be.revertedWithCustomError(acp, "EnforcedPause");
    });

    it("pause blocks submit", async function () {
      const jobId = await createAndFundJob();
      await acp.connect(owner).pause();

      await expect(
        acp.connect(provider).submit(jobId, ethers.id("work"))
      ).to.be.revertedWithCustomError(acp, "EnforcedPause");
    });

    it("pause blocks complete", async function () {
      const jobId = await createAndFundJob();
      await acp.connect(provider).submit(jobId, ethers.id("done"));
      await acp.connect(owner).pause();

      await expect(
        acp.connect(evaluator).complete(jobId, ethers.id("approved"))
      ).to.be.revertedWithCustomError(acp, "EnforcedPause");
    });

    it("unpause restores operations", async function () {
      await acp.connect(owner).pause();
      await acp.connect(owner).unpause();

      // createJob should work again
      const expiry = await futureExpiry();
      await expect(
        acp
          .connect(client)
          .createJob(
            provider.address,
            evaluator.address,
            expiry,
            "After unpause",
            ethers.ZeroAddress
          )
      ).to.not.be.reverted;
    });
  });

  // =========================================================================
  // Hook DoS resilience (new)
  // =========================================================================

  describe("Hook DoS resilience", function () {
    it("hook DoS: malicious hook revert does not block complete", async function () {
      // Deploy malicious hook
      const MaliciousHook = await ethers.getContractFactory("MaliciousHook");
      const maliciousHook = await MaliciousHook.deploy();
      await maliciousHook.waitForDeployment();

      // Create job with malicious hook
      const hookAddr = await maliciousHook.getAddress();
      const jobId = await createDefaultJob(hookAddr);

      // Set budget, fund, submit
      await acp.connect(client).setBudget(jobId, JOB_BUDGET);
      await usdc.connect(client).approve(await acp.getAddress(), JOB_BUDGET);
      await acp.connect(client).fund(jobId, JOB_BUDGET);
      await acp.connect(provider).submit(jobId, ethers.id("done"));

      // Complete should succeed even though hook reverts (try/catch)
      const providerBalBefore = await usdc.balanceOf(provider.address);
      const treasuryBalBefore = await usdc.balanceOf(treasury.address);

      await expect(
        acp.connect(evaluator).complete(jobId, ethers.id("approved"))
      ).to.not.be.reverted;

      // Verify payment was still released correctly
      const expectedFee = (JOB_BUDGET * PLATFORM_FEE_BPS) / BPS_DENOM;
      const expectedPayout = JOB_BUDGET - expectedFee;

      const providerBalAfter = await usdc.balanceOf(provider.address);
      const treasuryBalAfter = await usdc.balanceOf(treasury.address);

      expect(providerBalAfter - providerBalBefore).to.equal(expectedPayout);
      expect(treasuryBalAfter - treasuryBalBefore).to.equal(expectedFee);

      const job = await acp.getJob(jobId);
      expect(job.status).to.equal(3); // JobStatus.Completed
    });
  });

  // =========================================================================
  // Full lifecycle
  // =========================================================================

  describe("Full lifecycle", function () {
    it("happy path: create -> setBudget -> fund -> submit -> complete", async function () {
      const expiry = await futureExpiry();

      // 1. Create job
      const tx = await acp
        .connect(client)
        .createJob(
          provider.address,
          evaluator.address,
          expiry,
          "Full lifecycle test",
          ethers.ZeroAddress
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l: any) => l.fragment?.name === "JobCreated"
      );
      const jobId = event.args[0];

      // 2. Set budget
      await acp.connect(client).setBudget(jobId, JOB_BUDGET);
      let job = await acp.getJob(jobId);
      expect(job.budget).to.equal(JOB_BUDGET);

      // 3. Fund
      await acp.connect(client).fund(jobId, JOB_BUDGET);
      job = await acp.getJob(jobId);
      expect(job.status).to.equal(1); // Funded

      // 4. Submit
      const deliverable = ethers.id("final-deliverable");
      await acp.connect(provider).submit(jobId, deliverable);
      job = await acp.getJob(jobId);
      expect(job.status).to.equal(2); // Submitted
      expect(job.deliverable).to.equal(deliverable);

      // 5. Complete
      const providerBalBefore = await usdc.balanceOf(provider.address);
      const treasuryBalBefore = await usdc.balanceOf(treasury.address);

      await acp.connect(evaluator).complete(jobId, ethers.id("approved"));

      job = await acp.getJob(jobId);
      expect(job.status).to.equal(3); // Completed

      const expectedFee = (JOB_BUDGET * PLATFORM_FEE_BPS) / BPS_DENOM;
      const expectedPayout = JOB_BUDGET - expectedFee;

      expect(await usdc.balanceOf(provider.address)).to.equal(
        providerBalBefore + expectedPayout
      );
      expect(await usdc.balanceOf(treasury.address)).to.equal(
        treasuryBalBefore + expectedFee
      );

      // Contract should have zero balance
      expect(await usdc.balanceOf(await acp.getAddress())).to.equal(0n);
    });

    it("rejection path: create -> fund -> reject (refund)", async function () {
      const expiry = await futureExpiry();

      // 1. Create + budget + fund
      const tx = await acp
        .connect(client)
        .createJob(
          provider.address,
          evaluator.address,
          expiry,
          "Rejection test",
          ethers.ZeroAddress
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l: any) => l.fragment?.name === "JobCreated"
      );
      const jobId = event.args[0];

      await acp.connect(client).setBudget(jobId, JOB_BUDGET);

      const clientBalBefore = await usdc.balanceOf(client.address);
      await acp.connect(client).fund(jobId, JOB_BUDGET);

      // Verify funds left client
      const clientBalAfterFund = await usdc.balanceOf(client.address);
      expect(clientBalBefore - clientBalAfterFund).to.equal(JOB_BUDGET);

      // 2. Client rejects funded job
      await acp.connect(client).reject(jobId, ethers.id("cancelled"));

      const clientBalAfterReject = await usdc.balanceOf(client.address);
      expect(clientBalAfterReject).to.equal(clientBalBefore); // Full refund

      // Contract should have zero balance
      expect(await usdc.balanceOf(await acp.getAddress())).to.equal(0n);

      const job = await acp.getJob(jobId);
      expect(job.status).to.equal(4); // Rejected
    });
  });

  // =========================================================================
  // Fee calculation verification
  // =========================================================================

  describe("Fee calculation", function () {
    it("1% fee on 100 USDC = 1 USDC", async function () {
      const budget = 100n * ONE_USDC;
      const jobId = await createAndFundJob(budget);
      await acp.connect(provider).submit(jobId, ethers.id("done"));

      const treasuryBalBefore = await usdc.balanceOf(treasury.address);
      await acp.connect(evaluator).complete(jobId, ethers.id("ok"));
      const treasuryBalAfter = await usdc.balanceOf(treasury.address);

      expect(treasuryBalAfter - treasuryBalBefore).to.equal(ONE_USDC); // 1 USDC fee
    });

    it("1% fee on 1 USDC = 0.01 USDC", async function () {
      const budget = ONE_USDC;
      const jobId = await createDefaultJob();
      await acp.connect(client).setBudget(jobId, budget);
      await acp.connect(client).fund(jobId, budget);
      await acp.connect(provider).submit(jobId, ethers.id("done"));

      const treasuryBalBefore = await usdc.balanceOf(treasury.address);
      await acp.connect(evaluator).complete(jobId, ethers.id("ok"));
      const treasuryBalAfter = await usdc.balanceOf(treasury.address);

      // 1_000_000 * 100 / 10_000 = 10_000 (0.01 USDC)
      expect(treasuryBalAfter - treasuryBalBefore).to.equal(10_000n);
    });
  });

  // =========================================================================
  // Constants
  // =========================================================================

  describe("Constants", function () {
    it("PLATFORM_FEE_BPS is 100 (1%)", async function () {
      expect(await acp.PLATFORM_FEE_BPS()).to.equal(100);
    });

    it("BPS is 10000", async function () {
      expect(await acp.BPS()).to.equal(10_000);
    });
  });
});
