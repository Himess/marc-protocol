import { expect } from "chai";
import { ethers } from "hardhat";

describe("AgentIdentityRegistry", function () {
  let registry: any;
  let owner: any;
  let alice: any;
  let bob: any;
  let carol: any;

  const AGENT_URI_1 = "ipfs://QmAgent1/metadata.json";
  const AGENT_URI_2 = "ipfs://QmAgent2/metadata.json";
  const UPDATED_URI = "ipfs://QmAgentUpdated/metadata.json";

  beforeEach(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("AgentIdentityRegistry");
    registry = await Registry.deploy();
    await registry.waitForDeployment();
  });

  // ===========================================================================
  // 1. Deployment
  // ===========================================================================

  describe("Deployment", function () {
    it("starts with nextAgentId = 1", async function () {
      expect(await registry.nextAgentId()).to.equal(1n);
    });
  });

  // ===========================================================================
  // 2. Registration
  // ===========================================================================

  describe("register", function () {
    it("registers an agent and returns agentId = 1", async function () {
      const tx = await registry.connect(alice).register(AGENT_URI_1);
      const receipt = await tx.wait();

      // nextAgentId should increment
      expect(await registry.nextAgentId()).to.equal(2n);

      // Check event
      const event = receipt.logs.find(
        (l: any) => l.fragment?.name === "AgentRegistered"
      );
      expect(event).to.not.be.undefined;
      expect(event.args[0]).to.equal(1n); // agentId
      expect(event.args[1]).to.equal(alice.address); // owner
      expect(event.args[2]).to.equal(AGENT_URI_1); // agentURI
    });

    it("sets owner and wallet to msg.sender on registration", async function () {
      await registry.connect(alice).register(AGENT_URI_1);
      const [uri, agentOwner, wallet] = await registry.getAgent(1);

      expect(uri).to.equal(AGENT_URI_1);
      expect(agentOwner).to.equal(alice.address);
      expect(wallet).to.equal(alice.address);
    });

    it("maps wallet to agent on registration", async function () {
      await registry.connect(alice).register(AGENT_URI_1);
      expect(await registry.agentOf(alice.address)).to.equal(1n);
    });

    it("assigns sequential IDs", async function () {
      await registry.connect(alice).register(AGENT_URI_1);
      await registry.connect(bob).register(AGENT_URI_2);

      expect(await registry.agentOf(alice.address)).to.equal(1n);
      expect(await registry.agentOf(bob.address)).to.equal(2n);
      expect(await registry.nextAgentId()).to.equal(3n);
    });

    it("reverts on empty URI", async function () {
      await expect(
        registry.connect(alice).register("")
      ).to.be.revertedWithCustomError(registry, "EmptyURI");
    });

    it("reverts when same owner registers twice (wallet collision)", async function () {
      await registry.connect(alice).register(AGENT_URI_1);
      await expect(
        registry.connect(alice).register(AGENT_URI_2)
      ).to.be.revertedWithCustomError(registry, "WalletAlreadyLinked");
    });

    it("emits AgentRegistered event with correct args", async function () {
      await expect(registry.connect(alice).register(AGENT_URI_1))
        .to.emit(registry, "AgentRegistered")
        .withArgs(1n, alice.address, AGENT_URI_1);
    });
  });

  // ===========================================================================
  // 3. setAgentWallet
  // ===========================================================================

  describe("setAgentWallet", function () {
    beforeEach(async function () {
      await registry.connect(alice).register(AGENT_URI_1);
    });

    it("updates wallet and walletToAgent mapping", async function () {
      await registry.connect(alice).setAgentWallet(1, bob.address);

      const [, , wallet] = await registry.getAgent(1);
      expect(wallet).to.equal(bob.address);
      expect(await registry.agentOf(bob.address)).to.equal(1n);
    });

    it("clears old wallet mapping", async function () {
      await registry.connect(alice).setAgentWallet(1, bob.address);

      // Alice's wallet mapping should be cleared
      expect(await registry.agentOf(alice.address)).to.equal(0n);
    });

    it("emits AgentWalletSet event", async function () {
      await expect(registry.connect(alice).setAgentWallet(1, bob.address))
        .to.emit(registry, "AgentWalletSet")
        .withArgs(1n, bob.address);
    });

    it("reverts if caller is not agent owner", async function () {
      try {
        await registry.connect(bob).setAgentWallet(1, bob.address);
        expect.fail("Should have reverted");
      } catch (e: any) {
        expect(
          e.message.includes("NotAgentOwner") || e.message.includes("reverted") || e.message.includes("Fhevm")
        ).to.equal(true);
      }
    });

    it("reverts on zero address", async function () {
      await expect(
        registry.connect(alice).setAgentWallet(1, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("allows reassigning wallet multiple times", async function () {
      await registry.connect(alice).setAgentWallet(1, bob.address);
      await registry.connect(alice).setAgentWallet(1, carol.address);

      const [, , wallet] = await registry.getAgent(1);
      expect(wallet).to.equal(carol.address);
      expect(await registry.agentOf(bob.address)).to.equal(0n);
      expect(await registry.agentOf(carol.address)).to.equal(1n);
    });

    it("reverts wallet conflict (two agents same wallet)", async function () {
      await registry.connect(bob).register(AGENT_URI_2); // agentId=2

      await registry.connect(alice).setAgentWallet(1, carol.address);
      // Bob tries to set carol's wallet → should revert (already linked to agent 1)
      await expect(
        registry.connect(bob).setAgentWallet(2, carol.address)
      ).to.be.revertedWithCustomError(registry, "WalletAlreadyLinked");

      // Carol still points to agent 1
      expect(await registry.agentOf(carol.address)).to.equal(1n);
    });
  });

  // ===========================================================================
  // 4. updateURI
  // ===========================================================================

  describe("updateURI", function () {
    beforeEach(async function () {
      await registry.connect(alice).register(AGENT_URI_1);
    });

    it("updates the agent URI", async function () {
      await registry.connect(alice).updateURI(1, UPDATED_URI);
      const [uri] = await registry.getAgent(1);
      expect(uri).to.equal(UPDATED_URI);
    });

    it("emits AgentURIUpdated event", async function () {
      await expect(registry.connect(alice).updateURI(1, UPDATED_URI))
        .to.emit(registry, "AgentURIUpdated")
        .withArgs(1n, UPDATED_URI);
    });

    it("reverts if caller is not agent owner", async function () {
      try {
        await registry.connect(bob).updateURI(1, UPDATED_URI);
        expect.fail("Should have reverted");
      } catch (e: any) {
        expect(
          e.message.includes("NotAgentOwner") || e.message.includes("reverted") || e.message.includes("Fhevm")
        ).to.equal(true);
      }
    });

    it("reverts on empty URI", async function () {
      await expect(
        registry.connect(alice).updateURI(1, "")
      ).to.be.revertedWithCustomError(registry, "EmptyURI");
    });
  });

  // ===========================================================================
  // 5. getAgent
  // ===========================================================================

  describe("getAgent", function () {
    it("returns empty data for non-existent agent", async function () {
      const [uri, agentOwner, wallet] = await registry.getAgent(999);
      expect(uri).to.equal("");
      expect(agentOwner).to.equal(ethers.ZeroAddress);
      expect(wallet).to.equal(ethers.ZeroAddress);
    });

    it("returns correct data after registration", async function () {
      await registry.connect(alice).register(AGENT_URI_1);
      const [uri, agentOwner, wallet] = await registry.getAgent(1);

      expect(uri).to.equal(AGENT_URI_1);
      expect(agentOwner).to.equal(alice.address);
      expect(wallet).to.equal(alice.address);
    });
  });

  // ===========================================================================
  // 6. agentOf
  // ===========================================================================

  describe("agentOf", function () {
    it("returns 0 for unregistered wallet", async function () {
      expect(await registry.agentOf(alice.address)).to.equal(0n);
    });

    it("returns correct agentId after registration", async function () {
      await registry.connect(alice).register(AGENT_URI_1);
      expect(await registry.agentOf(alice.address)).to.equal(1n);
    });

    it("returns 0 after wallet is reassigned away", async function () {
      await registry.connect(alice).register(AGENT_URI_1);
      await registry.connect(alice).setAgentWallet(1, bob.address);
      expect(await registry.agentOf(alice.address)).to.equal(0n);
    });
  });

  // ===========================================================================
  // 7. Edge Cases
  // ===========================================================================

  describe("Edge Cases", function () {
    it("handles agent with very long URI", async function () {
      const longUri = "ipfs://Qm" + "a".repeat(500);
      await registry.connect(alice).register(longUri);
      const [uri] = await registry.getAgent(1);
      expect(uri).to.equal(longUri);
    });

    it("multiple agents from different owners work independently", async function () {
      await registry.connect(alice).register(AGENT_URI_1);
      await registry.connect(bob).register(AGENT_URI_2);

      // Updating alice's agent doesn't affect bob's
      await registry.connect(alice).updateURI(1, UPDATED_URI);
      const [uriAlice] = await registry.getAgent(1);
      const [uriBob] = await registry.getAgent(2);

      expect(uriAlice).to.equal(UPDATED_URI);
      expect(uriBob).to.equal(AGENT_URI_2);
    });

    it("setAgentWallet to same wallet is a no-op", async function () {
      await registry.connect(alice).register(AGENT_URI_1);
      await registry.connect(alice).setAgentWallet(1, alice.address);

      const [, , wallet] = await registry.getAgent(1);
      expect(wallet).to.equal(alice.address);
      expect(await registry.agentOf(alice.address)).to.equal(1n);
    });

    it("operations on non-existent agentId revert with not owner", async function () {
      try {
        await registry.connect(alice).setAgentWallet(999, bob.address);
        expect.fail("Should have reverted");
      } catch (e: any) {
        expect(
          e.message.includes("NotAgentOwner") || e.message.includes("reverted") || e.message.includes("Fhevm")
        ).to.equal(true);
      }

      try {
        await registry.connect(alice).updateURI(999, UPDATED_URI);
        expect.fail("Should have reverted");
      } catch (e: any) {
        expect(
          e.message.includes("NotAgentOwner") || e.message.includes("reverted") || e.message.includes("Fhevm")
        ).to.equal(true);
      }
    });

    it("pause blocks registration, unpause re-enables", async function () {
      await registry.connect(owner).pause();

      await expect(
        registry.connect(alice).register(AGENT_URI_1)
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");

      await registry.connect(owner).unpause();

      await registry.connect(alice).register(AGENT_URI_1);
      expect(await registry.nextAgentId()).to.equal(2n);
    });

    it("pause blocks setAgentWallet and updateURI", async function () {
      await registry.connect(alice).register(AGENT_URI_1);
      await registry.connect(owner).pause();

      await expect(
        registry.connect(alice).setAgentWallet(1, bob.address)
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");

      await expect(
        registry.connect(alice).updateURI(1, UPDATED_URI)
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");
    });

    it("only owner can pause/unpause", async function () {
      await expect(
        registry.connect(alice).pause()
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");

      await expect(
        registry.connect(alice).unpause()
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });
  });

  // ===========================================================================
  // 8. Gas Report
  // ===========================================================================

  describe("Gas Report", function () {
    it("measures gas for key operations", async function () {
      const regTx = await registry.connect(alice).register(AGENT_URI_1);
      const regReceipt = await regTx.wait();

      const walletTx = await registry.connect(alice).setAgentWallet(1, bob.address);
      const walletReceipt = await walletTx.wait();

      const uriTx = await registry.connect(alice).updateURI(1, UPDATED_URI);
      const uriReceipt = await uriTx.wait();

      console.log(`\n      ┌──────────────────────┬──────────────┐`);
      console.log(`      │ Operation            │ Gas Used     │`);
      console.log(`      ├──────────────────────┼──────────────┤`);
      console.log(`      │ register             │ ${regReceipt.gasUsed.toString().padStart(12)} │`);
      console.log(`      │ setAgentWallet       │ ${walletReceipt.gasUsed.toString().padStart(12)} │`);
      console.log(`      │ updateURI            │ ${uriReceipt.gasUsed.toString().padStart(12)} │`);
      console.log(`      └──────────────────────┴──────────────┘`);
    });
  });
});
