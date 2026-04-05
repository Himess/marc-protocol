import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mock ethers BEFORE importing tools
// ============================================================================

const mockApprove = vi.fn();
const mockBalanceOf = vi.fn().mockResolvedValue(5_000_000n);
const mockWrap = vi.fn();
const mockConfidentialTransfer = vi.fn();
const mockUnwrap = vi.fn();
const mockConfidentialBalanceOf = vi.fn();
const mockRecordPayment = vi.fn();
const mockGetAddress = vi.fn().mockResolvedValue("0x1234567890abcdef1234567890abcdef12345678");

vi.mock("ethers", () => ({
  Contract: vi.fn().mockImplementation((_addr: string, abi: any) => {
    const abiStr = JSON.stringify(abi);
    if (abiStr.includes("wrap")) {
      return {
        wrap: mockWrap,
        confidentialTransfer: mockConfidentialTransfer,
        unwrap: mockUnwrap,
        confidentialBalanceOf: mockConfidentialBalanceOf,
      };
    }
    if (abiStr.includes("recordPayment")) {
      return {
        recordPayment: mockRecordPayment,
      };
    }
    return {
      approve: mockApprove,
      balanceOf: mockBalanceOf,
    };
  }),
  ethers: {
    hexlify: vi.fn().mockReturnValue("0x" + "ab".repeat(32)),
    randomBytes: vi.fn().mockReturnValue(new Uint8Array(32)),
  },
}));

// ============================================================================
// Import after mocks
// ============================================================================

import {
  createMarcCrewTools,
  MarcWrapCrewTool,
  MarcUnwrapCrewTool,
  MarcTransferCrewTool,
  MarcBalanceCrewTool,
  MarcPayCrewTool,
  MarcToolError,
  MARC_SEPOLIA_ADDRESSES,
  MARC_MAINNET_ADDRESSES,
  TOKEN_ABI,
  VERIFIER_ABI,
  USDC_ABI,
} from "../src/index.js";
import type { Signer, FhevmInstance, CrewAITool } from "../src/index.js";

// ============================================================================
// Helpers
// ============================================================================

const VALID_ADDRESS_A = "0x1234567890abcdef1234567890abcdef12345678";
const VALID_ADDRESS_B = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const VALID_TOKEN = MARC_SEPOLIA_ADDRESSES.tokenAddress;
const VALID_VERIFIER = MARC_SEPOLIA_ADDRESSES.verifierAddress;
const VALID_USDC = MARC_SEPOLIA_ADDRESSES.usdcAddress;

function createMockSigner(): Signer {
  return {
    getAddress: mockGetAddress,
    signMessage: vi.fn().mockResolvedValue("0xmocksignature"),
  };
}

function createMockFhevmInstance(): FhevmInstance {
  return {
    createEncryptedInput: vi.fn().mockReturnValue({
      add64: vi.fn(),
      addAddress: vi.fn(),
      encrypt: vi.fn().mockResolvedValue({
        handles: ["0x" + "ff".repeat(32)],
        inputProof: "0x" + "ee".repeat(64),
      }),
    }),
  };
}

// ============================================================================
// createMarcCrewTools factory
// ============================================================================

describe("createMarcCrewTools", () => {
  it("returns 5 tools", () => {
    const tools = createMarcCrewTools(createMockSigner());
    expect(tools).toHaveLength(5);
  });

  it("returns tools with correct names", () => {
    const tools = createMarcCrewTools(createMockSigner());
    const names = tools.map((t) => t.name);
    expect(names).toContain("marc_wrap");
    expect(names).toContain("marc_unwrap");
    expect(names).toContain("marc_transfer");
    expect(names).toContain("marc_balance");
    expect(names).toContain("marc_pay");
  });

  it("each tool has description, args_schema, and run", () => {
    const tools = createMarcCrewTools(createMockSigner());
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.args_schema).toBeDefined();
      expect(typeof tool.run).toBe("function");
    }
  });

  it("accepts optional fhevmInstance", () => {
    const tools = createMarcCrewTools(createMockSigner(), createMockFhevmInstance());
    expect(tools).toHaveLength(5);
  });

  it("accepts optional config with custom addresses", () => {
    const customAddresses = {
      tokenAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      verifierAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      usdcAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
    };
    const tools = createMarcCrewTools(createMockSigner(), undefined, { addresses: customAddresses });
    expect(tools).toHaveLength(5);
  });
});

// ============================================================================
// Exported constants
// ============================================================================

describe("exported constants", () => {
  it("MARC_SEPOLIA_ADDRESSES has valid addresses", () => {
    expect(MARC_SEPOLIA_ADDRESSES.tokenAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(MARC_SEPOLIA_ADDRESSES.verifierAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(MARC_SEPOLIA_ADDRESSES.usdcAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("MARC_MAINNET_ADDRESSES has empty token and verifier", () => {
    expect(MARC_MAINNET_ADDRESSES.tokenAddress).toBe("");
    expect(MARC_MAINNET_ADDRESSES.verifierAddress).toBe("");
    expect(MARC_MAINNET_ADDRESSES.usdcAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("TOKEN_ABI contains key functions", () => {
    const abiStr = TOKEN_ABI.join(" ");
    expect(abiStr).toContain("confidentialTransfer");
    expect(abiStr).toContain("wrap");
    expect(abiStr).toContain("unwrap");
    expect(abiStr).toContain("confidentialBalanceOf");
  });

  it("VERIFIER_ABI contains key functions", () => {
    const abiStr = VERIFIER_ABI.join(" ");
    expect(abiStr).toContain("recordPayment");
    expect(abiStr).toContain("usedNonces");
    expect(abiStr).toContain("payAndRecord");
  });

  it("USDC_ABI contains approve and balanceOf", () => {
    const abiStr = USDC_ABI.join(" ");
    expect(abiStr).toContain("approve");
    expect(abiStr).toContain("balanceOf");
  });
});

// ============================================================================
// MarcWrapCrewTool
// ============================================================================

describe("MarcWrapCrewTool", () => {
  let tool: MarcWrapCrewTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new MarcWrapCrewTool(createMockSigner(), createMockFhevmInstance());

    mockApprove.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({ hash: "0xapprove", status: 1 }),
    });
    mockWrap.mockResolvedValue({
      hash: "0xwrap123",
      wait: vi.fn().mockResolvedValue({ hash: "0xwrap123", blockNumber: 100, status: 1 }),
    });
  });

  it("has correct name and description", () => {
    expect(tool.name).toBe("marc_wrap");
    expect(tool.description).toContain("Wrap");
    expect(tool.description).toContain("USDC");
  });

  it("has args_schema with amount required", () => {
    expect(tool.args_schema.required).toContain("amount");
  });

  it("wraps USDC successfully", async () => {
    const result = await tool.run({ amount: "1000000" });
    const parsed = JSON.parse(result);

    expect(parsed.action).toBe("wrap");
    expect(parsed.txHash).toBe("0xwrap123");
    expect(parsed.amount).toBe("1000000");
    expect(parsed.to).toBe(VALID_ADDRESS_A);
    expect(mockApprove).toHaveBeenCalledWith(VALID_TOKEN, 1_000_000n);
    expect(mockWrap).toHaveBeenCalledWith(VALID_ADDRESS_A, 1_000_000n);
  });

  it("wraps to custom recipient", async () => {
    const result = await tool.run({ amount: "500000", to: VALID_ADDRESS_B });
    const parsed = JSON.parse(result);

    expect(parsed.to).toBe(VALID_ADDRESS_B);
    expect(mockWrap).toHaveBeenCalledWith(VALID_ADDRESS_B, 500_000n);
  });

  it("throws on zero amount", async () => {
    await expect(tool.run({ amount: "0" })).rejects.toThrow("must be > 0");
  });

  it("throws on negative amount", async () => {
    await expect(tool.run({ amount: "-1" })).rejects.toThrow("must be > 0");
  });

  it("throws on reverted transaction", async () => {
    mockWrap.mockResolvedValue({
      hash: "0xfail",
      wait: vi.fn().mockResolvedValue({ hash: "0xfail", status: 0 }),
    });

    await expect(tool.run({ amount: "1000000" })).rejects.toThrow("Wrap transaction reverted");
  });
});

// ============================================================================
// MarcUnwrapCrewTool
// ============================================================================

describe("MarcUnwrapCrewTool", () => {
  let tool: MarcUnwrapCrewTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new MarcUnwrapCrewTool(createMockSigner(), createMockFhevmInstance());

    mockUnwrap.mockResolvedValue({
      hash: "0xunwrap123",
      wait: vi.fn().mockResolvedValue({ hash: "0xunwrap123", blockNumber: 200, status: 1 }),
    });
  });

  it("has correct name", () => {
    expect(tool.name).toBe("marc_unwrap");
  });

  it("unwraps cUSDC successfully", async () => {
    const result = await tool.run({ amount: "1000000" });
    const parsed = JSON.parse(result);

    expect(parsed.action).toBe("unwrap_requested");
    expect(parsed.txHash).toBe("0xunwrap123");
    expect(parsed.amount).toBe("1000000");
    expect(parsed.note).toContain("KMS");
  });

  it("throws without FhevmInstance", async () => {
    const noFheTool = new MarcUnwrapCrewTool(createMockSigner());
    await expect(noFheTool.run({ amount: "1000000" })).rejects.toThrow("FhevmInstance is required");
  });

  it("throws on zero amount", async () => {
    await expect(tool.run({ amount: "0" })).rejects.toThrow("must be > 0");
  });

  it("handles FHE encryption returning no handles", async () => {
    const badFhe: FhevmInstance = {
      createEncryptedInput: vi.fn().mockReturnValue({
        add64: vi.fn(),
        encrypt: vi.fn().mockResolvedValue({ handles: [], inputProof: "0x00" }),
      }),
    };
    const badTool = new MarcUnwrapCrewTool(createMockSigner(), badFhe);
    await expect(badTool.run({ amount: "1000000" })).rejects.toThrow("FHE encryption returned no handles");
  });
});

// ============================================================================
// MarcTransferCrewTool
// ============================================================================

describe("MarcTransferCrewTool", () => {
  let tool: MarcTransferCrewTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new MarcTransferCrewTool(createMockSigner(), createMockFhevmInstance());

    mockConfidentialTransfer.mockResolvedValue({
      hash: "0xtransfer123",
      wait: vi.fn().mockResolvedValue({ hash: "0xtransfer123", blockNumber: 300, status: 1 }),
    });
  });

  it("has correct name", () => {
    expect(tool.name).toBe("marc_transfer");
  });

  it("has args_schema with to and amount required", () => {
    expect(tool.args_schema.required).toContain("to");
    expect(tool.args_schema.required).toContain("amount");
  });

  it("transfers cUSDC successfully", async () => {
    const result = await tool.run({ to: VALID_ADDRESS_B, amount: "500000" });
    const parsed = JSON.parse(result);

    expect(parsed.action).toBe("confidential_transfer");
    expect(parsed.txHash).toBe("0xtransfer123");
    expect(parsed.to).toBe(VALID_ADDRESS_B);
    expect(parsed.encryptedHandle).toBe("0x" + "ff".repeat(32));
  });

  it("throws without FhevmInstance", async () => {
    const noFheTool = new MarcTransferCrewTool(createMockSigner());
    await expect(noFheTool.run({ to: VALID_ADDRESS_B, amount: "500000" })).rejects.toThrow(
      "FhevmInstance is required"
    );
  });

  it("throws on zero address recipient", async () => {
    await expect(
      tool.run({ to: "0x0000000000000000000000000000000000000000", amount: "1000000" })
    ).rejects.toThrow("Invalid to");
  });

  it("throws on invalid address format", async () => {
    await expect(tool.run({ to: "0xinvalid", amount: "1000000" })).rejects.toThrow("Invalid to");
  });

  it("throws on amount exceeding uint64 max", async () => {
    const overMax = (BigInt("0xFFFFFFFFFFFFFFFF") + 1n).toString();
    await expect(tool.run({ to: VALID_ADDRESS_B, amount: overMax })).rejects.toThrow("exceeds uint64 max");
  });

  it("propagates contract revert", async () => {
    mockConfidentialTransfer.mockResolvedValue({
      hash: "0xfail",
      wait: vi.fn().mockResolvedValue({ hash: "0xfail", status: 0 }),
    });

    await expect(tool.run({ to: VALID_ADDRESS_B, amount: "1000000" })).rejects.toThrow(
      "Confidential transfer reverted"
    );
  });
});

// ============================================================================
// MarcBalanceCrewTool
// ============================================================================

describe("MarcBalanceCrewTool", () => {
  let tool: MarcBalanceCrewTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new MarcBalanceCrewTool(createMockSigner(), createMockFhevmInstance());
    mockConfidentialBalanceOf.mockResolvedValue("0x" + "aa".repeat(32));
  });

  it("has correct name", () => {
    expect(tool.name).toBe("marc_balance");
  });

  it("returns non-zero balance handle", async () => {
    const result = await tool.run({});
    const parsed = JSON.parse(result);

    expect(parsed.action).toBe("balance");
    expect(parsed.address).toBe(VALID_ADDRESS_A);
    expect(parsed.hasEncryptedBalance).toBe(true);
    expect(parsed.note).toContain("Non-zero");
  });

  it("returns zero balance handle", async () => {
    mockConfidentialBalanceOf.mockResolvedValue("0x" + "00".repeat(32));

    const result = await tool.run({});
    const parsed = JSON.parse(result);

    expect(parsed.hasEncryptedBalance).toBe(false);
    expect(parsed.note).toContain("Zero balance");
  });

  it("handles confidentialBalanceOf failure gracefully", async () => {
    mockConfidentialBalanceOf.mockRejectedValue(new Error("not available"));

    const result = await tool.run({});
    const parsed = JSON.parse(result);

    expect(parsed.hasEncryptedBalance).toBe(false);
  });

  it("queries custom address", async () => {
    const result = await tool.run({ address: VALID_ADDRESS_B });
    const parsed = JSON.parse(result);

    expect(parsed.address).toBe(VALID_ADDRESS_B);
    expect(mockConfidentialBalanceOf).toHaveBeenCalledWith(VALID_ADDRESS_B);
  });

  it("throws on invalid address", async () => {
    await expect(tool.run({ address: "0xinvalid" })).rejects.toThrow("Invalid address");
  });
});

// ============================================================================
// MarcPayCrewTool
// ============================================================================

describe("MarcPayCrewTool", () => {
  let tool: MarcPayCrewTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new MarcPayCrewTool(createMockSigner(), createMockFhevmInstance());

    mockConfidentialTransfer.mockResolvedValue({
      hash: "0xtransfer_x402",
      wait: vi.fn().mockResolvedValue({ hash: "0xtransfer_x402", blockNumber: 400, status: 1 }),
    });
    mockRecordPayment.mockResolvedValue({
      hash: "0xverifier_x402",
      wait: vi.fn().mockResolvedValue({ hash: "0xverifier_x402", blockNumber: 401, status: 1 }),
    });
  });

  it("has correct name", () => {
    expect(tool.name).toBe("marc_pay");
  });

  it("has args_schema with url required", () => {
    expect(tool.args_schema.required).toContain("url");
  });

  it("throws without FhevmInstance", async () => {
    const noFheTool = new MarcPayCrewTool(createMockSigner());
    await expect(noFheTool.run({ url: "https://example.com/api" })).rejects.toThrow(
      "FhevmInstance is required"
    );
  });

  it("throws when URL is empty", async () => {
    await expect(tool.run({ url: "" })).rejects.toThrow("URL is required");
  });

  it("completes full x402 payment flow", async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({
      status: 402,
      json: vi.fn().mockResolvedValue({
        x402Version: 1,
        accepts: [
          {
            scheme: "fhe-confidential-v1",
            network: "eip155:11155111",
            price: "1000000",
            recipientAddress: VALID_ADDRESS_B,
          },
        ],
      }),
    });
    mockFetch.mockResolvedValueOnce({ status: 200, statusText: "OK" });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;

    try {
      const result = await tool.run({ url: "https://example.com/api" });
      const parsed = JSON.parse(result);

      expect(parsed.action).toBe("x402_payment");
      expect(parsed.transferTxHash).toBe("0xtransfer_x402");
      expect(parsed.verifierTxHash).toBe("0xverifier_x402");
      expect(parsed.nonce).toBeDefined();
      expect(parsed.paymentHeader).toBeDefined();
      expect(parsed.resourceUrl).toBe("https://example.com/api");
      expect(parsed.resourceResponse.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws when resource does not return 402", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 200 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;

    try {
      await expect(tool.run({ url: "https://example.com/free" })).rejects.toThrow(
        "Resource did not return 402"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws when no matching scheme found", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 402,
      json: vi.fn().mockResolvedValue({
        x402Version: 1,
        accepts: [{ scheme: "other-scheme", price: "1000000" }],
      }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;

    try {
      await expect(tool.run({ url: "https://example.com/api" })).rejects.toThrow(
        "No matching payment requirement found"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("respects maxPayment cap", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 402,
      json: vi.fn().mockResolvedValue({
        x402Version: 1,
        accepts: [
          {
            scheme: "fhe-confidential-v1",
            price: "10000000",
            recipientAddress: VALID_ADDRESS_B,
          },
        ],
      }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;

    try {
      await expect(
        tool.run({ url: "https://example.com/api", maxPayment: "1000000" })
      ).rejects.toThrow("No matching payment requirement found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ============================================================================
// MarcToolError
// ============================================================================

describe("MarcToolError", () => {
  it("includes message and name", () => {
    const err = new MarcToolError("test error");
    expect(err.message).toBe("test error");
    expect(err.name).toBe("MarcToolError");
  });

  it("includes details", () => {
    const err = new MarcToolError("test", { txHash: "0x123" });
    expect(err.details).toEqual({ txHash: "0x123" });
  });

  it("is an instance of Error", () => {
    const err = new MarcToolError("test");
    expect(err).toBeInstanceOf(Error);
  });
});

// ============================================================================
// CrewAITool interface compliance
// ============================================================================

describe("CrewAITool interface compliance", () => {
  it("all tools implement name, description, args_schema, run", () => {
    const tools = createMarcCrewTools(createMockSigner(), createMockFhevmInstance());
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.args_schema).toBe("object");
      expect(tool.args_schema.type).toBe("object");
      expect(typeof tool.run).toBe("function");
    }
  });

  it("tool names are snake_case", () => {
    const tools = createMarcCrewTools(createMockSigner());
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
    }
  });

  it("each args_schema has properties", () => {
    const tools = createMarcCrewTools(createMockSigner());
    for (const tool of tools) {
      expect(tool.args_schema.properties).toBeDefined();
      expect(typeof tool.args_schema.properties).toBe("object");
    }
  });

  it("run method returns a string", async () => {
    mockApprove.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({ hash: "0xapprove", status: 1 }),
    });
    mockWrap.mockResolvedValue({
      hash: "0xwrap",
      wait: vi.fn().mockResolvedValue({ hash: "0xwrap", blockNumber: 1, status: 1 }),
    });

    const tool = new MarcWrapCrewTool(createMockSigner(), createMockFhevmInstance());
    const result = await tool.run({ amount: "1000000" });
    expect(typeof result).toBe("string");
    // Should be valid JSON
    expect(() => JSON.parse(result)).not.toThrow();
  });
});
