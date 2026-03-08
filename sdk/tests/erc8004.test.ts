import { describe, it, expect } from "vitest";
import { fhePaymentMethod, fhePaymentProof } from "../src/erc8004/index.js";

describe("fhePaymentMethod", () => {
  it("returns default payment method entry", () => {
    const result = fhePaymentMethod({
      poolAddress: "0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73",
    });

    expect(result.scheme).toBe("fhe-confidential-v1");
    expect(result.network).toBe("eip155:11155111");
    expect(result.token).toBe("USDC");
    expect(result.pool).toBe("0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73");
    expect(result.privacyLevel).toBe("encrypted-balances");
    expect(result.features).toContain("fhe-encrypted-amounts");
    expect(result.features).toContain("silent-failure-privacy");
    expect(result.description).toBeDefined();
  });

  it("uses custom network and token", () => {
    const result = fhePaymentMethod({
      poolAddress: "0x1111111111111111111111111111111111111111",
      network: "eip155:1",
      token: "WETH",
    });

    expect(result.network).toBe("eip155:1");
    expect(result.token).toBe("WETH");
  });

  it("uses custom facilitator URL", () => {
    const result = fhePaymentMethod({
      poolAddress: "0x1111111111111111111111111111111111111111",
      facilitatorUrl: "https://custom.facilitator.com",
    });

    expect(result.facilitator).toBe("https://custom.facilitator.com");
  });

  it("uses default facilitator URL", () => {
    const result = fhePaymentMethod({
      poolAddress: "0x1111111111111111111111111111111111111111",
    });

    expect(result.facilitator).toBe("https://facilitator.fhe-x402.xyz");
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
    expect(result.pool).toBe("0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73");
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
