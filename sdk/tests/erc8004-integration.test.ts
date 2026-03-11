import { describe, it, expect } from "vitest";
import {
  fhePaymentMethod,
  fhePaymentProof,
  createAgentRegistration,
  generateFeedbackData,
  ERC8004_IDENTITY_ABI,
  ERC8004_REPUTATION_ABI,
} from "../src/erc8004/index.js";

// ============================================================================
// fhePaymentMethod
// ============================================================================

describe("fhePaymentMethod", () => {
  it("returns correct scheme and privacy level", () => {
    const result = fhePaymentMethod({
      tokenAddress: "0x1111111111111111111111111111111111111111",
      verifierAddress: "0x2222222222222222222222222222222222222222",
    });

    expect(result.scheme).toBe("fhe-confidential-v1");
    expect(result.privacyLevel).toBe("encrypted-balances");
  });

  it("returns correct default network and token", () => {
    const result = fhePaymentMethod({
      tokenAddress: "0x1111111111111111111111111111111111111111",
      verifierAddress: "0x2222222222222222222222222222222222222222",
    });

    expect(result.network).toBe("eip155:11155111");
    expect(result.token).toBe("USDC");
  });

  it("includes all required features", () => {
    const result = fhePaymentMethod({
      tokenAddress: "0x1111111111111111111111111111111111111111",
      verifierAddress: "0x2222222222222222222222222222222222222222",
    });

    expect(result.features).toContain("fhe-encrypted-amounts");
    expect(result.features).toContain("token-centric");
    expect(result.features).toContain("fee-free-transfers");
    expect(result.tokenAddress).toBe("0x1111111111111111111111111111111111111111");
    expect(result.verifier).toBe("0x2222222222222222222222222222222222222222");
  });
});

// ============================================================================
// fhePaymentProof
// ============================================================================

describe("fhePaymentProof", () => {
  it("returns correct type and nonce", () => {
    const result = fhePaymentProof(
      "0xabc123",
      "0x1111111111111111111111111111111111111111"
    );

    expect(result.type).toBe("fhe-x402-nonce");
    expect(result.nonce).toBe("0xabc123");
  });

  it("uses default network (Sepolia)", () => {
    const result = fhePaymentProof(
      "0xnonce",
      "0x1111111111111111111111111111111111111111"
    );

    expect(result.network).toBe("eip155:11155111");
  });

  it("includes a valid timestamp", () => {
    const before = Date.now();
    const result = fhePaymentProof(
      "0xnonce",
      "0x1111111111111111111111111111111111111111"
    );
    const after = Date.now();

    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
  });
});

// ============================================================================
// createAgentRegistration
// ============================================================================

describe("createAgentRegistration", () => {
  const defaultConfig = {
    services: ["data-analysis", "image-generation"],
    tokenAddress: "0xaaaa111111111111111111111111111111111111",
    verifierAddress: "0xbbbb222222222222222222222222222222222222",
  };

  it("sets x402Support to true", () => {
    const reg = createAgentRegistration(defaultConfig);
    expect(reg.x402Support).toBe(true);
  });

  it("includes correct services list", () => {
    const reg = createAgentRegistration(defaultConfig);
    expect(reg.services).toEqual(["data-analysis", "image-generation"]);
  });

  it("includes ERC-8004 registration with correct network", () => {
    const reg = createAgentRegistration(defaultConfig);
    expect(reg.registrations).toHaveLength(1);
    expect(reg.registrations[0].standard).toBe("ERC-8004");
    expect(reg.registrations[0].network).toBe("eip155:11155111");
  });

  it("uses correct scheme", () => {
    const reg = createAgentRegistration(defaultConfig);
    expect(reg.scheme).toBe("fhe-confidential-v1");
  });

  it("includes payment method with correct addresses", () => {
    const reg = createAgentRegistration(defaultConfig);
    expect(reg.paymentMethod.tokenAddress).toBe(defaultConfig.tokenAddress);
    expect(reg.paymentMethod.verifier).toBe(defaultConfig.verifierAddress);
    expect(reg.paymentMethod.scheme).toBe("fhe-confidential-v1");
  });

  it("uses custom network when provided", () => {
    const reg = createAgentRegistration({
      ...defaultConfig,
      network: "eip155:1",
    });
    expect(reg.registrations[0].network).toBe("eip155:1");
    expect(reg.paymentMethod.network).toBe("eip155:1");
  });
});

// ============================================================================
// generateFeedbackData
// ============================================================================

describe("generateFeedbackData", () => {
  it("returns correct agentId and score", () => {
    const proof = fhePaymentProof(
      "0xnonce",
      "0x1111111111111111111111111111111111111111"
    );
    const data = generateFeedbackData(42n, 5, ["quality", "speed"], proof);

    expect(data.agentId).toBe(42n);
    expect(data.score).toBe(5);
  });

  it("includes all tags", () => {
    const proof = fhePaymentProof(
      "0xnonce",
      "0x1111111111111111111111111111111111111111"
    );
    const data = generateFeedbackData(1n, 4, ["reliable", "fast", "accurate"], proof);

    expect(data.tags).toEqual(["reliable", "fast", "accurate"]);
    expect(data.tags).toHaveLength(3);
  });

  it("serializes proofOfPayment as JSON string", () => {
    const proof = fhePaymentProof(
      "0xmynonce",
      "0x1111111111111111111111111111111111111111"
    );
    const data = generateFeedbackData(10n, 3, ["ok"], proof);

    const parsed = JSON.parse(data.proofOfPayment);
    expect(parsed.type).toBe("fhe-x402-nonce");
    expect(parsed.nonce).toBe("0xmynonce");
    expect(parsed.tokenAddress).toBe("0x1111111111111111111111111111111111111111");
  });

  it("accepts number for agentId and converts to bigint", () => {
    const proof = fhePaymentProof(
      "0xnonce",
      "0x1111111111111111111111111111111111111111"
    );
    const data = generateFeedbackData(7, 5, [], proof);

    expect(data.agentId).toBe(7n);
    expect(typeof data.agentId).toBe("bigint");
  });
});

// ============================================================================
// ABI exports
// ============================================================================

describe("ABI exports", () => {
  it("ERC8004_IDENTITY_ABI has register and setAgentWallet functions", () => {
    const abiStr = ERC8004_IDENTITY_ABI.join(" ");
    expect(abiStr).toContain("register");
    expect(abiStr).toContain("setAgentWallet");
    expect(abiStr).toContain("getAgent");
    expect(abiStr).toContain("AgentRegistered");
  });

  it("ERC8004_REPUTATION_ABI has giveFeedback and getSummary functions", () => {
    const abiStr = ERC8004_REPUTATION_ABI.join(" ");
    expect(abiStr).toContain("giveFeedback");
    expect(abiStr).toContain("getSummary");
    expect(abiStr).toContain("getFeedback");
    expect(abiStr).toContain("FeedbackGiven");
  });
});
