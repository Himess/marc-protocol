import { describe, it, expect, vi } from "vitest";
import { Interface } from "ethers";
import {
  fhePaymentMethod,
  fhePaymentProof,
  ERC8004_IDENTITY_ABI,
  ERC8004_REPUTATION_ABI,
  connectIdentityRegistry,
  connectReputationRegistry,
  registerAgent,
  setAgentWallet,
  getAgent,
  agentOf,
  giveFeedback,
  getReputationSummary,
} from "../src/erc8004/index.js";

describe("fhePaymentMethod", () => {
  it("returns default payment method entry", () => {
    const result = fhePaymentMethod({
      tokenAddress: "0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73",
      verifierAddress: "0x1234567890abcdef1234567890abcdef12345678",
    });

    expect(result.scheme).toBe("fhe-confidential-v1");
    expect(result.network).toBe("eip155:11155111");
    expect(result.token).toBe("USDC");
    expect(result.tokenAddress).toBe("0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73");
    expect(result.verifier).toBe("0x1234567890abcdef1234567890abcdef12345678");
    expect(result.privacyLevel).toBe("encrypted-balances");
    expect(result.features).toContain("fhe-encrypted-amounts");
    expect(result.features).toContain("token-centric");
    expect(result.description).toBeDefined();
  });

  it("uses custom network and token", () => {
    const result = fhePaymentMethod({
      tokenAddress: "0x1111111111111111111111111111111111111111",
      verifierAddress: "0x2222222222222222222222222222222222222222",
      network: "eip155:1",
      token: "WETH",
    });

    expect(result.network).toBe("eip155:1");
    expect(result.token).toBe("WETH");
  });

  it("uses custom facilitator URL", () => {
    const result = fhePaymentMethod({
      tokenAddress: "0x1111111111111111111111111111111111111111",
      verifierAddress: "0x2222222222222222222222222222222222222222",
      facilitatorUrl: "https://custom.facilitator.com",
    });

    expect(result).toBeDefined();
    expect(result.scheme).toBe("fhe-confidential-v1");
  });
});

describe("fhePaymentProof", () => {
  it("creates nonce-based payment proof", () => {
    const result = fhePaymentProof(
      "0xabc123nonce",
      "0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73"
    );

    expect(result.type).toBe("fhe-x402-nonce");
    expect(result.nonce).toBe("0xabc123nonce");
    expect(result.tokenAddress).toBe("0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73");
    expect(result.network).toBe("eip155:11155111");
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it("uses custom network", () => {
    const result = fhePaymentProof(
      "0xnonce",
      "0x1111111111111111111111111111111111111111",
      "eip155:1"
    );

    expect(result.network).toBe("eip155:1");
  });
});

// ============================================================================
// Contract interaction functions
// ============================================================================

/** Helper to build mock contract with method stubs */
function createMockContract(abi: readonly string[], overrides: Record<string, any> = {}) {
  const iface = new Interface([...abi]);

  function makeReceipt(hash: string, eventName: string, args: any[]) {
    const fragment = iface.getEvent(eventName);
    if (!fragment) throw new Error(`Event ${eventName} not found in ABI`);
    const log = iface.encodeEventLog(fragment, args);
    return {
      hash,
      logs: [{ topics: [...log.topics], data: log.data }],
    };
  }

  const mockTx = (receipt: any) => ({
    wait: vi.fn().mockResolvedValue(receipt),
  });

  const contract: any = {
    interface: iface,
    register: vi.fn(),
    setAgentWallet: vi.fn(),
    getAgent: vi.fn(),
    agentOf: vi.fn(),
    giveFeedback: vi.fn(),
    getSummary: vi.fn(),
    ...overrides,
  };

  return { contract, mockTx, makeReceipt };
}

describe("connectIdentityRegistry", () => {
  it("returns a Contract instance", () => {
    const mockSigner: any = { provider: null, getAddress: vi.fn() };
    const registry = connectIdentityRegistry(
      "0x1234567890abcdef1234567890abcdef12345678",
      mockSigner
    );
    expect(registry).toBeDefined();
    expect(registry.interface).toBeDefined();
  });
});

describe("connectReputationRegistry", () => {
  it("returns a Contract instance", () => {
    const mockSigner: any = { provider: null, getAddress: vi.fn() };
    const registry = connectReputationRegistry(
      "0x1234567890abcdef1234567890abcdef12345678",
      mockSigner
    );
    expect(registry).toBeDefined();
    expect(registry.interface).toBeDefined();
  });
});

describe("registerAgent", () => {
  it("returns agentId and txHash from AgentRegistered event", async () => {
    const { contract, mockTx, makeReceipt } = createMockContract(ERC8004_IDENTITY_ABI);
    const receipt = makeReceipt(
      "0xregisterhash",
      "AgentRegistered",
      [
        7n,
        "0x0000000000000000000000000000000000000001", // owner (indexed)
        "ipfs://agent-uri",
      ]
    );
    contract.register.mockResolvedValue(mockTx(receipt));

    const result = await registerAgent(contract, "ipfs://agent-uri");

    expect(result.agentId).toBe(7n);
    expect(result.txHash).toBe("0xregisterhash");
    expect(contract.register).toHaveBeenCalledWith("ipfs://agent-uri");
  });

  it("throws if AgentRegistered event not found", async () => {
    const { contract, mockTx } = createMockContract(ERC8004_IDENTITY_ABI);
    const receipt = { hash: "0xnoevent", logs: [] };
    contract.register.mockResolvedValue(mockTx(receipt));

    await expect(registerAgent(contract, "ipfs://test")).rejects.toThrow(
      "AgentRegistered event not found"
    );
  });
});

describe("setAgentWallet", () => {
  it("calls setAgentWallet and returns tx hash", async () => {
    const { contract, mockTx } = createMockContract(ERC8004_IDENTITY_ABI);
    const receipt = { hash: "0xwallethash" };
    contract.setAgentWallet.mockResolvedValue(mockTx(receipt));

    const hash = await setAgentWallet(
      contract,
      1n,
      "0x0000000000000000000000000000000000000042"
    );
    expect(hash).toBe("0xwallethash");
    expect(contract.setAgentWallet).toHaveBeenCalledWith(
      1n,
      "0x0000000000000000000000000000000000000042"
    );
  });
});

describe("getAgent", () => {
  it("returns parsed agent struct", async () => {
    const { contract } = createMockContract(ERC8004_IDENTITY_ABI);
    contract.getAgent.mockResolvedValue([
      "ipfs://agent-uri",
      "0xOwnerAddr",
      "0xWalletAddr",
    ]);

    const agent = await getAgent(contract, 1n);

    expect(agent.uri).toBe("ipfs://agent-uri");
    expect(agent.owner).toBe("0xOwnerAddr");
    expect(agent.wallet).toBe("0xWalletAddr");
  });

  it("accepts number agentId", async () => {
    const { contract } = createMockContract(ERC8004_IDENTITY_ABI);
    contract.getAgent.mockResolvedValue(["", "0x00", "0x00"]);

    await getAgent(contract, 42);
    expect(contract.getAgent).toHaveBeenCalledWith(42);
  });
});

describe("agentOf", () => {
  it("returns agentId for a wallet address", async () => {
    const { contract } = createMockContract(ERC8004_IDENTITY_ABI);
    contract.agentOf.mockResolvedValue(5n);

    const id = await agentOf(contract, "0x0000000000000000000000000000000000000042");
    expect(id).toBe(5n);
  });

  it("returns 0n for unregistered wallet", async () => {
    const { contract } = createMockContract(ERC8004_IDENTITY_ABI);
    contract.agentOf.mockResolvedValue(0n);

    const id = await agentOf(contract, "0x0000000000000000000000000000000000000099");
    expect(id).toBe(0n);
  });
});

describe("giveFeedback", () => {
  it("calls giveFeedback with encoded tags and proof", async () => {
    const { contract, mockTx } = createMockContract(ERC8004_REPUTATION_ABI);
    const receipt = { hash: "0xfeedbackhash" };
    contract.giveFeedback.mockResolvedValue(mockTx(receipt));

    const hash = await giveFeedback(contract, {
      agentId: 1n,
      score: 85,
      tags: ["fast", "reliable"],
      proofOfPayment: '{"type":"fhe-x402-nonce","nonce":"0xabc"}',
    });

    expect(hash).toBe("0xfeedbackhash");
    expect(contract.giveFeedback).toHaveBeenCalled();

    // Verify args: agentId, score, encoded tags (bytes32[]), encoded proof (bytes)
    const callArgs = contract.giveFeedback.mock.calls[0];
    expect(callArgs[0]).toBe(1n);
    expect(callArgs[1]).toBe(85);
    expect(callArgs[2]).toHaveLength(2); // 2 tags
    expect(callArgs[3]).toBeInstanceOf(Uint8Array); // proof bytes
  });
});

describe("getReputationSummary", () => {
  it("returns parsed reputation summary", async () => {
    const { contract } = createMockContract(ERC8004_REPUTATION_ABI);
    contract.getSummary.mockResolvedValue([10n, 80n, 1700000000n]);

    const summary = await getReputationSummary(contract, 1n);

    expect(summary.totalFeedback).toBe(10n);
    expect(summary.averageScore).toBe(80n);
    expect(summary.lastUpdated).toBe(1700000000n);
  });

  it("accepts number agentId", async () => {
    const { contract } = createMockContract(ERC8004_REPUTATION_ABI);
    contract.getSummary.mockResolvedValue([0n, 0n, 0n]);

    await getReputationSummary(contract, 42);
    expect(contract.getSummary).toHaveBeenCalledWith(42);
  });
});
