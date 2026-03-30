import { expect } from "chai";
import { ethers } from "hardhat";

describe("AgentReputationRegistry", function () {
  let reputation: any;
  let mockVerifier: any;
  let owner: any;
  let reviewer1: any;
  let reviewer2: any;
  let reviewer3: any;

  const AGENT_ID_1 = 1;
  const AGENT_ID_2 = 2;

  // Helper: create a nonce, register it in the mock verifier, and return the proof bytes
  async function makeRegisteredProof(): Promise<string> {
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    await mockVerifier.registerNonce(nonce);
    return ethers.solidityPacked(["bytes32"], [nonce]);
  }

  // Helper: create a proof bytes from a nonce WITHOUT registering (for negative tests)
  function makeUnregisteredProof(): string {
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    return ethers.solidityPacked(["bytes32"], [nonce]);
  }

  // Helper: create tags
  function makeTags(tagStrings: string[]): string[] {
    return tagStrings.map((t) => ethers.encodeBytes32String(t));
  }

  beforeEach(async function () {
    [owner, reviewer1, reviewer2, reviewer3] = await ethers.getSigners();

    const MockVerifier = await ethers.getContractFactory("MockX402Verifier");
    mockVerifier = await MockVerifier.deploy();
    await mockVerifier.waitForDeployment();

    const Reputation = await ethers.getContractFactory("AgentReputationRegistry");
    reputation = await Reputation.deploy(await mockVerifier.getAddress());
    await reputation.waitForDeployment();
  });

  // ===========================================================================
  // 1. Deployment
  // ===========================================================================

  describe("Deployment", function () {
    it("deploys with zero state", async function () {
      const count = await reputation.feedbackCount(AGENT_ID_1);
      expect(count).to.equal(0n);

      const [totalFeedback, avgScore, lastUpdated] = await reputation.getSummary(AGENT_ID_1);
      expect(totalFeedback).to.equal(0n);
      expect(avgScore).to.equal(0n);
      expect(lastUpdated).to.equal(0n);
    });
  });

  // ===========================================================================
  // 2. giveFeedback
  // ===========================================================================

  describe("giveFeedback", function () {
    it("submits feedback with score, tags, and proof", async function () {
      const tags = makeTags(["reliable", "fast"]);
      const proof = await makeRegisteredProof();

      const tx = await reputation.connect(reviewer1).giveFeedback(
        AGENT_ID_1, 200, tags, proof
      );
      const receipt = await tx.wait();

      expect(await reputation.feedbackCount(AGENT_ID_1)).to.equal(1n);

      // Check event
      const event = receipt.logs.find(
        (l: any) => l.fragment?.name === "FeedbackGiven"
      );
      expect(event).to.not.be.undefined;
      expect(event.args[0]).to.equal(BigInt(AGENT_ID_1));
      expect(event.args[1]).to.equal(reviewer1.address);
      expect(event.args[2]).to.equal(200);
    });

    it("emits FeedbackGiven event", async function () {
      const proof = await makeRegisteredProof();

      await expect(
        reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 150, [], proof)
      )
        .to.emit(reputation, "FeedbackGiven")
        .withArgs(BigInt(AGENT_ID_1), reviewer1.address, 150);
    });

    it("reverts on invalid agent ID (0)", async function () {
      const proof = await makeRegisteredProof();
      await expect(
        reputation.connect(reviewer1).giveFeedback(0, 100, [], proof)
      ).to.be.revertedWithCustomError(reputation, "InvalidAgentId");
    });

    it("reverts on empty proof", async function () {
      await expect(
        reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 100, [], "0x")
      ).to.be.revertedWithCustomError(reputation, "ProofRequired");
    });

    it("reverts on invalid proof of payment (nonce not in verifier)", async function () {
      const proof = makeUnregisteredProof();
      await expect(
        reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 100, [], proof)
      ).to.be.revertedWithCustomError(reputation, "InvalidProofOfPayment");
    });

    it("accepts score of 0", async function () {
      const proof = await makeRegisteredProof();
      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 0, [], proof);

      const [reviewer, score] = await reputation.getFeedback(AGENT_ID_1, 0);
      expect(score).to.equal(0);
    });

    it("accepts max score of 255", async function () {
      const proof = await makeRegisteredProof();
      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 255, [], proof);

      const [, score] = await reputation.getFeedback(AGENT_ID_1, 0);
      expect(score).to.equal(255);
    });

    it("accepts feedback with no tags", async function () {
      const proof = await makeRegisteredProof();
      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 100, [], proof);

      const [, , tags] = await reputation.getFeedback(AGENT_ID_1, 0);
      expect(tags.length).to.equal(0);
    });

    it("accepts feedback with multiple tags", async function () {
      const tags = makeTags(["reliable", "fast", "accurate", "cheap"]);
      const proof = await makeRegisteredProof();

      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 200, tags, proof);

      const [, , storedTags] = await reputation.getFeedback(AGENT_ID_1, 0);
      expect(storedTags.length).to.equal(4);
    });

    it("allows same reviewer to give feedback multiple times", async function () {
      const proof1 = await makeRegisteredProof();
      const proof2 = await makeRegisteredProof();

      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 200, [], proof1);
      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 100, [], proof2);

      expect(await reputation.feedbackCount(AGENT_ID_1)).to.equal(2n);
    });
  });

  // ===========================================================================
  // 3. getSummary
  // ===========================================================================

  describe("getSummary", function () {
    it("returns zero for agent with no feedback", async function () {
      const [total, avg, lastUpdated] = await reputation.getSummary(999);
      expect(total).to.equal(0n);
      expect(avg).to.equal(0n);
      expect(lastUpdated).to.equal(0n);
    });

    it("calculates average score correctly (single feedback)", async function () {
      const proof = await makeRegisteredProof();
      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 200, [], proof);

      const [total, avg] = await reputation.getSummary(AGENT_ID_1);
      expect(total).to.equal(1n);
      expect(avg).to.equal(200n);
    });

    it("calculates average score correctly (multiple feedbacks)", async function () {
      const proof1 = await makeRegisteredProof();
      const proof2 = await makeRegisteredProof();
      const proof3 = await makeRegisteredProof();

      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 200, [], proof1);
      await reputation.connect(reviewer2).giveFeedback(AGENT_ID_1, 100, [], proof2);
      await reputation.connect(reviewer3).giveFeedback(AGENT_ID_1, 255, [], proof3);

      const [total, avg] = await reputation.getSummary(AGENT_ID_1);
      expect(total).to.equal(3n);
      // (200 + 100 + 255) / 3 = 555 / 3 = 185 (integer division)
      expect(avg).to.equal(185n);
    });

    it("average uses integer division (rounds down)", async function () {
      const proof1 = await makeRegisteredProof();
      const proof2 = await makeRegisteredProof();

      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 5, [], proof1);
      await reputation.connect(reviewer2).giveFeedback(AGENT_ID_1, 4, [], proof2);

      const [, avg] = await reputation.getSummary(AGENT_ID_1);
      // (5 + 4) / 2 = 4 (integer division rounds down)
      expect(avg).to.equal(4n);
    });

    it("updates lastUpdated timestamp", async function () {
      const proof = await makeRegisteredProof();
      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 200, [], proof);

      const [, , lastUpdated] = await reputation.getSummary(AGENT_ID_1);
      expect(lastUpdated).to.be.gt(0n);

      const block = await ethers.provider.getBlock("latest");
      expect(lastUpdated).to.equal(BigInt(block!.timestamp));
    });

    it("different agents have independent summaries", async function () {
      const proof1 = await makeRegisteredProof();
      const proof2 = await makeRegisteredProof();

      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 255, [], proof1);
      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_2, 50, [], proof2);

      const [total1, avg1] = await reputation.getSummary(AGENT_ID_1);
      const [total2, avg2] = await reputation.getSummary(AGENT_ID_2);

      expect(total1).to.equal(1n);
      expect(avg1).to.equal(255n);
      expect(total2).to.equal(1n);
      expect(avg2).to.equal(50n);
    });
  });

  // ===========================================================================
  // 4. getFeedback
  // ===========================================================================

  describe("getFeedback", function () {
    it("returns correct feedback entry", async function () {
      const tags = makeTags(["reliable"]);
      const proof = await makeRegisteredProof();

      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 180, tags, proof);

      const [reviewer, score, storedTags, timestamp] = await reputation.getFeedback(AGENT_ID_1, 0);
      expect(reviewer).to.equal(reviewer1.address);
      expect(score).to.equal(180);
      expect(storedTags.length).to.equal(1);
      expect(timestamp).to.be.gt(0n);
    });

    it("returns multiple feedback entries in order", async function () {
      const proof1 = await makeRegisteredProof();
      const proof2 = await makeRegisteredProof();

      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 200, [], proof1);
      await reputation.connect(reviewer2).giveFeedback(AGENT_ID_1, 100, [], proof2);

      const [r1, s1] = await reputation.getFeedback(AGENT_ID_1, 0);
      const [r2, s2] = await reputation.getFeedback(AGENT_ID_1, 1);

      expect(r1).to.equal(reviewer1.address);
      expect(s1).to.equal(200);
      expect(r2).to.equal(reviewer2.address);
      expect(s2).to.equal(100);
    });

    it("reverts on out-of-bounds index", async function () {
      await expect(
        reputation.getFeedback(AGENT_ID_1, 0)
      ).to.be.revertedWithCustomError(reputation, "IndexOutOfBounds");
    });

    it("reverts on index just past the end", async function () {
      const proof = await makeRegisteredProof();
      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 100, [], proof);

      await expect(
        reputation.getFeedback(AGENT_ID_1, 1)
      ).to.be.revertedWithCustomError(reputation, "IndexOutOfBounds");
    });
  });

  // ===========================================================================
  // 5.5. Pausable
  // ===========================================================================

  describe("Pausable", function () {
    it("pause blocks giveFeedback", async function () {
      await reputation.connect(owner).pause();
      const proof = await makeRegisteredProof();

      await expect(
        reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 100, [], proof)
      ).to.be.revertedWithCustomError(reputation, "EnforcedPause");
    });

    it("unpause re-enables giveFeedback", async function () {
      await reputation.connect(owner).pause();
      await reputation.connect(owner).unpause();

      const proof = await makeRegisteredProof();
      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 100, [], proof);
      expect(await reputation.feedbackCount(AGENT_ID_1)).to.equal(1n);
    });

    it("only owner can pause/unpause", async function () {
      await expect(
        reputation.connect(reviewer1).pause()
      ).to.be.revertedWithCustomError(reputation, "OwnableUnauthorizedAccount");

      await expect(
        reputation.connect(reviewer1).unpause()
      ).to.be.revertedWithCustomError(reputation, "OwnableUnauthorizedAccount");
    });

    it("getSummary and getFeedback still work when paused", async function () {
      const proof = await makeRegisteredProof();
      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 200, [], proof);

      await reputation.connect(owner).pause();

      // View functions should still work
      const [total, avg] = await reputation.getSummary(AGENT_ID_1);
      expect(total).to.equal(1n);
      expect(avg).to.equal(200n);

      const [reviewer] = await reputation.getFeedback(AGENT_ID_1, 0);
      expect(reviewer).to.equal(reviewer1.address);
    });
  });

  // ===========================================================================
  // 5. feedbackCount
  // ===========================================================================

  describe("feedbackCount", function () {
    it("returns 0 for agent with no feedback", async function () {
      expect(await reputation.feedbackCount(AGENT_ID_1)).to.equal(0n);
    });

    it("increments with each feedback", async function () {
      for (let i = 0; i < 5; i++) {
        const proof = await makeRegisteredProof();
        await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 100 + i, [], proof);
      }
      expect(await reputation.feedbackCount(AGENT_ID_1)).to.equal(5n);
    });

    it("tracks count per agent independently", async function () {
      const proof1 = await makeRegisteredProof();
      const proof2 = await makeRegisteredProof();
      const proof3 = await makeRegisteredProof();

      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 200, [], proof1);
      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 200, [], proof2);
      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_2, 100, [], proof3);

      expect(await reputation.feedbackCount(AGENT_ID_1)).to.equal(2n);
      expect(await reputation.feedbackCount(AGENT_ID_2)).to.equal(1n);
    });
  });

  // ===========================================================================
  // 6. Edge Cases
  // ===========================================================================

  describe("Edge Cases", function () {
    it("handles large number of feedbacks (10)", async function () {
      for (let i = 0; i < 10; i++) {
        const proof = await makeRegisteredProof();
        await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 100 + i, [], proof);
      }

      const [total, avg] = await reputation.getSummary(AGENT_ID_1);
      expect(total).to.equal(10n);
      // (100+101+...+109) / 10 = 1045 / 10 = 104
      expect(avg).to.equal(104n);
    });

    it("handles all-zero scores", async function () {
      for (let i = 0; i < 3; i++) {
        const proof = await makeRegisteredProof();
        await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 0, [], proof);
      }

      const [total, avg] = await reputation.getSummary(AGENT_ID_1);
      expect(total).to.equal(3n);
      expect(avg).to.equal(0n);
    });

    it("handles all-max scores", async function () {
      for (let i = 0; i < 3; i++) {
        const proof = await makeRegisteredProof();
        await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 255, [], proof);
      }

      const [total, avg] = await reputation.getSummary(AGENT_ID_1);
      expect(total).to.equal(3n);
      expect(avg).to.equal(255n);
    });

    it("handles large proof data", async function () {
      // Large proof — first 32 bytes used as nonce, must be registered
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      await mockVerifier.registerNonce(nonce);
      const largeProof = nonce + ethers.hexlify(ethers.randomBytes(224)).slice(2);
      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 100, [], largeProof);

      expect(await reputation.feedbackCount(AGENT_ID_1)).to.equal(1n);
    });

    it("handles many tags", async function () {
      const tags = makeTags(["a", "b", "c", "d", "e", "f", "g", "h"]);
      const proof = await makeRegisteredProof();

      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 200, tags, proof);

      const [, , storedTags] = await reputation.getFeedback(AGENT_ID_1, 0);
      expect(storedTags.length).to.equal(8);
    });

    it("multiple reviewers for same agent", async function () {
      const proof1 = await makeRegisteredProof();
      const proof2 = await makeRegisteredProof();
      const proof3 = await makeRegisteredProof();

      await reputation.connect(reviewer1).giveFeedback(AGENT_ID_1, 200, [], proof1);
      await reputation.connect(reviewer2).giveFeedback(AGENT_ID_1, 150, [], proof2);
      await reputation.connect(reviewer3).giveFeedback(AGENT_ID_1, 100, [], proof3);

      const [total, avg] = await reputation.getSummary(AGENT_ID_1);
      expect(total).to.equal(3n);
      expect(avg).to.equal(150n); // (200+150+100)/3 = 150
    });
  });

  // ===========================================================================
  // 7. Gas Report
  // ===========================================================================

  describe("Gas Report", function () {
    it("measures gas for key operations", async function () {
      const tags = makeTags(["reliable", "fast"]);
      const proof = await makeRegisteredProof();

      const fbTx = await reputation.connect(reviewer1).giveFeedback(
        AGENT_ID_1, 200, tags, proof
      );
      const fbReceipt = await fbTx.wait();

      const proof2 = await makeRegisteredProof();
      const fbNoTagsTx = await reputation.connect(reviewer2).giveFeedback(
        AGENT_ID_1, 150, [], proof2
      );
      const fbNoTagsReceipt = await fbNoTagsTx.wait();

      console.log(`\n      ┌──────────────────────────────┬──────────────┐`);
      console.log(`      │ Operation                    │ Gas Used     │`);
      console.log(`      ├──────────────────────────────┼──────────────┤`);
      console.log(`      │ giveFeedback (2 tags)        │ ${fbReceipt.gasUsed.toString().padStart(12)} │`);
      console.log(`      │ giveFeedback (no tags)       │ ${fbNoTagsReceipt.gasUsed.toString().padStart(12)} │`);
      console.log(`      └──────────────────────────────┴──────────────┘`);
    });
  });
});
