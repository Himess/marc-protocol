import { describe, it, expect, vi, beforeEach } from "vitest";
import { FhePaymentHandler, decodePaymentHeader } from "../src/fhePaymentHandler.js";
import { FHE_SCHEME } from "../src/types.js";
import type { FhevmInstance, FhePaymentRequirements, FhePaymentRequired } from "../src/types.js";

// ============================================================================
// Mock helpers
// ============================================================================

function createMockSigner(address: string = "0xAliceAddress") {
  return {
    getAddress: vi.fn().mockResolvedValue(address),
    provider: {
      getTransactionReceipt: vi.fn().mockResolvedValue({ status: 1, blockNumber: 100 }),
    },
  } as any;
}

function createMockFhevmInstance(): FhevmInstance {
  return {
    createEncryptedInput: vi.fn().mockReturnValue({
      add64: vi.fn(),
      addAddress: vi.fn(),
      encrypt: vi.fn().mockResolvedValue({
        handles: ["0xhandle123"],
        inputProof: "0xproof123",
      }),
    }),
  };
}

function createMockRequirements(overrides?: Partial<FhePaymentRequirements>): FhePaymentRequirements {
  return {
    scheme: FHE_SCHEME,
    network: "eip155:11155111",
    chainId: 11155111,
    price: "1000000",
    asset: "USDC",
    tokenAddress: "0xTokenAddress",
    verifierAddress: "0xVerifierAddress",
    recipientAddress: "0xRecipientAddress",
    maxTimeoutSeconds: 300,
    ...overrides,
  };
}

function create402Response(requirements: FhePaymentRequirements[]): Response {
  const body: FhePaymentRequired = {
    x402Version: 1,
    accepts: requirements,
    resource: { url: "https://api.example.com/data", method: "GET" },
  };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: { "Content-Type": "application/json" },
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("FhePaymentHandler", () => {
  let handler: FhePaymentHandler;
  let mockSigner: any;
  let mockFhevm: FhevmInstance;

  beforeEach(() => {
    mockSigner = createMockSigner();
    mockFhevm = createMockFhevmInstance();
    handler = new FhePaymentHandler(mockSigner, mockFhevm);
  });

  describe("parsePaymentRequired", () => {
    it("should parse valid 402 response", async () => {
      const requirements = createMockRequirements();
      const response = create402Response([requirements]);

      const result = await handler.parsePaymentRequired(response);
      expect(result).not.toBeNull();
      expect(result!.x402Version).toBe(1);
      expect(result!.accepts).toHaveLength(1);
      expect(result!.accepts[0].scheme).toBe(FHE_SCHEME);
    });

    it("should return null for non-402 response", async () => {
      const response = new Response("OK", { status: 200 });
      const result = await handler.parsePaymentRequired(response);
      expect(result).toBeNull();
    });

    it("should return null for invalid JSON", async () => {
      const response = new Response("not json", { status: 402 });
      const result = await handler.parsePaymentRequired(response);
      expect(result).toBeNull();
    });

    it("should return null for wrong version", async () => {
      const response = new Response(
        JSON.stringify({ x402Version: 99, accepts: [] }),
        { status: 402 }
      );
      const result = await handler.parsePaymentRequired(response);
      expect(result).toBeNull();
    });

    it("should return null for missing accepts array", async () => {
      const response = new Response(
        JSON.stringify({ x402Version: 1 }),
        { status: 402 }
      );
      const result = await handler.parsePaymentRequired(response);
      expect(result).toBeNull();
    });
  });

  describe("selectRequirement", () => {
    it("should select matching FHE requirement", () => {
      const req = createMockRequirements();
      const result = handler.selectRequirement([req]);
      expect(result).toBe(req);
    });

    it("should skip non-FHE schemes", () => {
      const req = createMockRequirements({ scheme: "other" as any });
      const result = handler.selectRequirement([req]);
      expect(result).toBeNull();
    });

    it("should respect allowedNetworks filter", () => {
      handler = new FhePaymentHandler(mockSigner, mockFhevm, {
        allowedNetworks: ["eip155:1"],
      });
      const req = createMockRequirements({ network: "eip155:11155111" });
      const result = handler.selectRequirement([req]);
      expect(result).toBeNull();
    });

    it("should allow matching network", () => {
      handler = new FhePaymentHandler(mockSigner, mockFhevm, {
        allowedNetworks: ["eip155:11155111"],
      });
      const req = createMockRequirements({ network: "eip155:11155111" });
      const result = handler.selectRequirement([req]);
      expect(result).toBe(req);
    });

    it("should respect maxPayment limit", () => {
      handler = new FhePaymentHandler(mockSigner, mockFhevm, {
        maxPayment: 500_000n,
      });
      const req = createMockRequirements({ price: "1000000" }); // 1 USDC > 0.5 USDC max
      const result = handler.selectRequirement([req]);
      expect(result).toBeNull();
    });

    it("should allow amount under maxPayment", () => {
      handler = new FhePaymentHandler(mockSigner, mockFhevm, {
        maxPayment: 5_000_000n,
      });
      const req = createMockRequirements({ price: "1000000" });
      const result = handler.selectRequirement([req]);
      expect(result).toBe(req);
    });

    it("should select first matching from multiple requirements", () => {
      const req1 = createMockRequirements({ price: "1000000" });
      const req2 = createMockRequirements({ price: "2000000" });
      const result = handler.selectRequirement([req1, req2]);
      expect(result).toBe(req1);
    });
  });

  describe("decodePaymentHeader", () => {
    it("should encode and decode payment header", () => {
      const payload = {
        scheme: FHE_SCHEME as typeof FHE_SCHEME,
        txHash: "0xabc123",
        verifierTxHash: "0xdef456",
        nonce: "0x" + "ff".repeat(32),
        from: "0xAlice",
        chainId: 11155111,
        signature: "0xtest",
      };
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
      const decoded = decodePaymentHeader(encoded);
      expect(decoded.scheme).toBe(FHE_SCHEME);
      expect(decoded.txHash).toBe("0xabc123");
      expect(decoded.from).toBe("0xAlice");
    });

    it("should throw on invalid base64", () => {
      expect(() => decodePaymentHeader("!!!invalid!!!")).toThrow();
    });
  });

  describe("constructor", () => {
    it("should create handler with default options", () => {
      const h = new FhePaymentHandler(mockSigner, mockFhevm);
      expect(h).toBeDefined();
    });

    it("should create handler with custom options", () => {
      const h = new FhePaymentHandler(mockSigner, mockFhevm, {
        maxPayment: 100_000_000n,
        allowedNetworks: ["eip155:11155111"],
      });
      expect(h).toBeDefined();
    });
  });

  describe("handlePaymentRequired", () => {
    it("should return null for non-402 response", async () => {
      const response = new Response("OK", { status: 200 });
      const result = await handler.handlePaymentRequired(response);
      expect(result).toBeNull();
    });

    it("should return null when no matching requirement", async () => {
      handler = new FhePaymentHandler(mockSigner, mockFhevm, {
        allowedNetworks: ["eip155:1"],
      });
      const req = createMockRequirements({ network: "eip155:11155111" });
      const response = create402Response([req]);
      const result = await handler.handlePaymentRequired(response);
      expect(result).toBeNull();
    });
  });
});
