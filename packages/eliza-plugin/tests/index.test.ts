import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mock ethers BEFORE importing plugin
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
      // Token contract (cUSDC / ERC-7984)
      return {
        wrap: mockWrap,
        confidentialTransfer: mockConfidentialTransfer,
        unwrap: mockUnwrap,
        confidentialBalanceOf: mockConfidentialBalanceOf,
      };
    }
    if (abiStr.includes("recordPayment")) {
      // Verifier contract
      return {
        recordPayment: mockRecordPayment,
      };
    }
    // USDC contract
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
  marcPlugin,
  marcWrapAction,
  marcUnwrapAction,
  marcTransferAction,
  marcBalanceAction,
  marcPayAction,
  MARC_SEPOLIA_ADDRESSES,
  TOKEN_ABI,
  VERIFIER_ABI,
  USDC_ABI,
} from "../src/index.js";
import type { ElizaContext, Signer, FhevmInstance } from "../src/index.js";

// ============================================================================
// Helpers
// ============================================================================

const VALID_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const VALID_ADDRESS_B = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

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
      encrypt: vi.fn().mockResolvedValue({
        handles: ["0x" + "ff".repeat(32)],
        inputProof: "0x" + "ee".repeat(64),
      }),
    }),
  };
}

function createContext(opts: { fhevm?: boolean; addresses?: any } = {}): ElizaContext {
  return {
    signer: createMockSigner(),
    fhevmInstance: opts.fhevm !== false ? createMockFhevmInstance() : undefined,
    addresses: opts.addresses,
  };
}

function txReceipt(hash: string, blockNumber = 12345) {
  return { wait: vi.fn().mockResolvedValue({ hash, blockNumber }) };
}

// ============================================================================
// Plugin structure tests
// ============================================================================

describe("marcPlugin structure", () => {
  it("exports a valid plugin object", () => {
    expect(marcPlugin).toBeDefined();
    expect(marcPlugin.name).toBe("marc-protocol");
    expect(typeof marcPlugin.description).toBe("string");
    expect(marcPlugin.description.length).toBeGreaterThan(0);
  });

  it("contains exactly 5 actions", () => {
    expect(marcPlugin.actions).toHaveLength(5);
  });

  it("has correct action names", () => {
    const names = marcPlugin.actions.map((a) => a.name);
    expect(names).toEqual(["MARC_WRAP", "MARC_UNWRAP", "MARC_TRANSFER", "MARC_BALANCE", "MARC_PAY"]);
  });

  it("all actions have descriptions", () => {
    for (const action of marcPlugin.actions) {
      expect(typeof action.description).toBe("string");
      expect(action.description.length).toBeGreaterThan(10);
    }
  });

  it("all actions have examples", () => {
    for (const action of marcPlugin.actions) {
      expect(action.examples.length).toBeGreaterThan(0);
      for (const example of action.examples) {
        expect(example.length).toBe(2);
        expect(example[0]).toMatch(/^user:/);
        expect(example[1]).toMatch(/^assistant:/);
      }
    }
  });

  it("all actions have validate and handler functions", () => {
    for (const action of marcPlugin.actions) {
      expect(typeof action.validate).toBe("function");
      expect(typeof action.handler).toBe("function");
    }
  });
});

// ============================================================================
// Exports
// ============================================================================

describe("module exports", () => {
  it("exports MARC_SEPOLIA_ADDRESSES", () => {
    expect(MARC_SEPOLIA_ADDRESSES.tokenAddress).toMatch(/^0x/);
    expect(MARC_SEPOLIA_ADDRESSES.verifierAddress).toMatch(/^0x/);
    expect(MARC_SEPOLIA_ADDRESSES.usdcAddress).toMatch(/^0x/);
  });

  it("exports contract ABIs", () => {
    expect(TOKEN_ABI.length).toBeGreaterThan(0);
    expect(VERIFIER_ABI.length).toBeGreaterThan(0);
    expect(USDC_ABI.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// MARC_WRAP
// ============================================================================

describe("MARC_WRAP", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApprove.mockResolvedValue(txReceipt("0xapprove"));
    mockWrap.mockResolvedValue(txReceipt("0xwrap123", 100));
  });

  it("validates correct params", () => {
    expect(marcWrapAction.validate({ amount: "100" })).toBe(true);
    expect(marcWrapAction.validate({ amount: "0.5" })).toBe(true);
    expect(marcWrapAction.validate({ amount: 25 })).toBe(true);
  });

  it("rejects invalid params", () => {
    expect(marcWrapAction.validate({ amount: "0" })).toBe(false);
    expect(marcWrapAction.validate({ amount: "-1" })).toBe(false);
    expect(marcWrapAction.validate({ amount: "abc" })).toBe(false);
    expect(marcWrapAction.validate({})).toBe(false);
    expect(marcWrapAction.validate({ amount: null })).toBe(false);
  });

  it("wraps USDC successfully", async () => {
    const ctx = createContext();
    const result = await marcWrapAction.handler({ amount: "10" }, ctx);

    expect(result.success).toBe(true);
    expect(result.message).toContain("Wrapped 10 USDC");
    expect(result.data?.action).toBe("wrap");
    expect(result.data?.txHash).toBe("0xwrap123");
    expect(result.data?.blockNumber).toBe(100);
    expect(mockApprove).toHaveBeenCalled();
    expect(mockWrap).toHaveBeenCalledWith(VALID_ADDRESS, 10_000_000n);
  });

  it("wraps fractional USDC", async () => {
    const ctx = createContext();
    await marcWrapAction.handler({ amount: "0.5" }, ctx);
    expect(mockWrap).toHaveBeenCalledWith(VALID_ADDRESS, 500_000n);
  });

  it("wraps to custom recipient", async () => {
    const ctx = createContext();
    await marcWrapAction.handler({ amount: "1", to: VALID_ADDRESS_B }, ctx);
    expect(mockWrap).toHaveBeenCalledWith(VALID_ADDRESS_B, 1_000_000n);
  });

  it("handles wrap failure gracefully", async () => {
    mockWrap.mockRejectedValue(new Error("Insufficient USDC balance"));
    const ctx = createContext();
    const result = await marcWrapAction.handler({ amount: "999" }, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Insufficient USDC balance");
  });

  it("handles invalid amount in handler", async () => {
    const ctx = createContext();
    const result = await marcWrapAction.handler({ amount: "-1" }, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Invalid amount");
  });
});

// ============================================================================
// MARC_UNWRAP
// ============================================================================

describe("MARC_UNWRAP", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUnwrap.mockResolvedValue(txReceipt("0xunwrap456", 200));
  });

  it("validates correct params", () => {
    expect(marcUnwrapAction.validate({ amount: "50" })).toBe(true);
    expect(marcUnwrapAction.validate({ amount: 10 })).toBe(true);
  });

  it("rejects invalid params", () => {
    expect(marcUnwrapAction.validate({ amount: "0" })).toBe(false);
    expect(marcUnwrapAction.validate({ amount: "-5" })).toBe(false);
    expect(marcUnwrapAction.validate({})).toBe(false);
  });

  it("unwraps cUSDC successfully", async () => {
    const ctx = createContext();
    const result = await marcUnwrapAction.handler({ amount: "5" }, ctx);

    expect(result.success).toBe(true);
    expect(result.message).toContain("Unwrap of 5 cUSDC");
    expect(result.message).toContain("KMS");
    expect(result.data?.action).toBe("unwrap_requested");
    expect(result.data?.txHash).toBe("0xunwrap456");
    expect(mockUnwrap).toHaveBeenCalledWith(
      VALID_ADDRESS,
      VALID_ADDRESS,
      "0x" + "ff".repeat(32),
      "0x" + "ee".repeat(64)
    );
  });

  it("fails without fhevmInstance", async () => {
    const ctx = createContext({ fhevm: false });
    const result = await marcUnwrapAction.handler({ amount: "5" }, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain("fhevmInstance is required");
  });

  it("handles unwrap error gracefully", async () => {
    mockUnwrap.mockRejectedValue(new Error("Insufficient encrypted balance"));
    const ctx = createContext();
    const result = await marcUnwrapAction.handler({ amount: "999" }, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Insufficient encrypted balance");
  });

  it("handles FHE encryption failure", async () => {
    const ctx = createContext();
    (ctx.fhevmInstance!.createEncryptedInput as any).mockReturnValue({
      add64: vi.fn(),
      encrypt: vi.fn().mockResolvedValue({ handles: [], inputProof: "" }),
    });
    const result = await marcUnwrapAction.handler({ amount: "1" }, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain("no handles");
  });
});

// ============================================================================
// MARC_TRANSFER
// ============================================================================

describe("MARC_TRANSFER", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfidentialTransfer.mockResolvedValue(txReceipt("0xtransfer789", 300));
  });

  it("validates correct params", () => {
    expect(marcTransferAction.validate({ to: VALID_ADDRESS_B, amount: "10" })).toBe(true);
  });

  it("rejects invalid address", () => {
    expect(marcTransferAction.validate({ to: "not-an-address", amount: "10" })).toBe(false);
    expect(marcTransferAction.validate({ to: "0x123", amount: "10" })).toBe(false);
  });

  it("rejects missing amount", () => {
    expect(marcTransferAction.validate({ to: VALID_ADDRESS_B })).toBe(false);
  });

  it("rejects invalid amount", () => {
    expect(marcTransferAction.validate({ to: VALID_ADDRESS_B, amount: "0" })).toBe(false);
    expect(marcTransferAction.validate({ to: VALID_ADDRESS_B, amount: "-5" })).toBe(false);
  });

  it("transfers cUSDC successfully", async () => {
    const ctx = createContext();
    const result = await marcTransferAction.handler({ to: VALID_ADDRESS_B, amount: "25" }, ctx);

    expect(result.success).toBe(true);
    expect(result.message).toContain("Sent 25 cUSDC");
    expect(result.data?.action).toBe("confidential_transfer");
    expect(result.data?.txHash).toBe("0xtransfer789");
    expect(result.data?.to).toBe(VALID_ADDRESS_B);
    expect(mockConfidentialTransfer).toHaveBeenCalledWith(
      VALID_ADDRESS_B,
      "0x" + "ff".repeat(32),
      "0x" + "ee".repeat(64)
    );
  });

  it("fails without fhevmInstance", async () => {
    const ctx = createContext({ fhevm: false });
    const result = await marcTransferAction.handler({ to: VALID_ADDRESS_B, amount: "10" }, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain("fhevmInstance is required");
  });

  it("handles transfer error gracefully", async () => {
    mockConfidentialTransfer.mockRejectedValue(new Error("Execution reverted"));
    const ctx = createContext();
    const result = await marcTransferAction.handler({ to: VALID_ADDRESS_B, amount: "10" }, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Execution reverted");
  });

  it("handles FHE encryption failure", async () => {
    const ctx = createContext();
    (ctx.fhevmInstance!.createEncryptedInput as any).mockReturnValue({
      add64: vi.fn(),
      encrypt: vi.fn().mockResolvedValue({ handles: [], inputProof: "" }),
    });
    const result = await marcTransferAction.handler({ to: VALID_ADDRESS_B, amount: "10" }, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain("no handles");
  });
});

// ============================================================================
// MARC_BALANCE
// ============================================================================

describe("MARC_BALANCE", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBalanceOf.mockResolvedValue(5_000_000n);
    mockConfidentialBalanceOf.mockResolvedValue("0x" + "aa".repeat(32));
  });

  it("validates with no params", () => {
    expect(marcBalanceAction.validate({})).toBe(true);
  });

  it("validates with valid address", () => {
    expect(marcBalanceAction.validate({ address: VALID_ADDRESS })).toBe(true);
  });

  it("rejects invalid address", () => {
    expect(marcBalanceAction.validate({ address: "bad" })).toBe(false);
  });

  it("returns balance successfully", async () => {
    const ctx = createContext();
    const result = await marcBalanceAction.handler({}, ctx);

    expect(result.success).toBe(true);
    expect(result.message).toContain("5.00");
    expect(result.data?.publicBalanceUSDC).toBe("5.00");
    expect(result.data?.walletAddress).toBe(VALID_ADDRESS);
    expect(result.data?.hasEncryptedBalance).toBe(true);
    expect(result.data?.encryptedBalanceHandle).toBe("0x" + "aa".repeat(32));
  });

  it("shows no encrypted balance when handle is zero", async () => {
    mockConfidentialBalanceOf.mockResolvedValue("0x" + "00".repeat(32));
    const ctx = createContext();
    const result = await marcBalanceAction.handler({}, ctx);

    expect(result.success).toBe(true);
    expect(result.data?.hasEncryptedBalance).toBe(false);
  });

  it("handles confidentialBalanceOf failure gracefully", async () => {
    mockConfidentialBalanceOf.mockRejectedValue(new Error("not available"));
    const ctx = createContext();
    const result = await marcBalanceAction.handler({}, ctx);

    expect(result.success).toBe(true);
    expect(result.data?.publicBalanceUSDC).toBe("5.00");
    expect(result.data?.hasEncryptedBalance).toBe(false);
  });

  it("handles zero balance", async () => {
    mockBalanceOf.mockResolvedValue(0n);
    mockConfidentialBalanceOf.mockResolvedValue("0x" + "00".repeat(32));
    const ctx = createContext();
    const result = await marcBalanceAction.handler({}, ctx);

    expect(result.success).toBe(true);
    expect(result.data?.publicBalanceUSDC).toBe("0.00");
    expect(result.data?.hasEncryptedBalance).toBe(false);
  });

  it("handles RPC error", async () => {
    mockBalanceOf.mockRejectedValue(new Error("RPC timeout"));
    const ctx = createContext();
    const result = await marcBalanceAction.handler({}, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain("RPC timeout");
  });

  it("checks balance for specific address", async () => {
    const ctx = createContext();
    const result = await marcBalanceAction.handler({ address: VALID_ADDRESS_B }, ctx);

    expect(result.success).toBe(true);
    expect(result.data?.walletAddress).toBe(VALID_ADDRESS_B);
  });
});

// ============================================================================
// MARC_PAY
// ============================================================================

describe("MARC_PAY", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfidentialTransfer.mockResolvedValue(txReceipt("0xpaytransfer", 400));
    mockRecordPayment.mockResolvedValue(txReceipt("0xpayverifier", 401));

    // Mock global fetch for x402 flow
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, opts?: any) => {
        if (opts?.headers?.Payment) {
          // Retry request with Payment header
          return Promise.resolve({
            status: 200,
            statusText: "OK",
            json: () => Promise.resolve({ content: "premium data" }),
          });
        }
        // Initial request returns 402
        return Promise.resolve({
          status: 402,
          statusText: "Payment Required",
          json: () =>
            Promise.resolve({
              x402Version: 1,
              accepts: [
                {
                  scheme: "fhe-confidential-v1",
                  price: "1000000",
                  recipientAddress: VALID_ADDRESS_B,
                  network: "eip155:11155111",
                },
              ],
            }),
        });
      })
    );
  });

  it("validates correct params", () => {
    expect(marcPayAction.validate({ url: "https://api.example.com" })).toBe(true);
    expect(marcPayAction.validate({ url: "http://localhost:3000" })).toBe(true);
  });

  it("rejects invalid params", () => {
    expect(marcPayAction.validate({})).toBe(false);
    expect(marcPayAction.validate({ url: "" })).toBe(false);
    expect(marcPayAction.validate({ url: "not-a-url" })).toBe(false);
    expect(marcPayAction.validate({ url: 123 })).toBe(false);
  });

  it("completes full x402 payment flow", async () => {
    const ctx = createContext();
    const result = await marcPayAction.handler({ url: "https://api.example.com/premium" }, ctx);

    expect(result.success).toBe(true);
    expect(result.message).toContain("1.00 USDC");
    expect(result.data?.action).toBe("x402_payment");
    expect(result.data?.transferTxHash).toBe("0xpaytransfer");
    expect(result.data?.verifierTxHash).toBe("0xpayverifier");
    expect(result.data?.nonce).toBeDefined();
    expect(result.data?.paymentHeader).toBeDefined();
    expect((result.data?.resourceResponse as any)?.status).toBe(200);

    // Verify fetch was called twice (initial + retry)
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails without fhevmInstance", async () => {
    const ctx = createContext({ fhevm: false });
    const result = await marcPayAction.handler({ url: "https://api.example.com" }, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain("fhevmInstance is required");
  });

  it("fails when resource does not return 402", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        statusText: "OK",
      })
    );

    const ctx = createContext();
    const result = await marcPayAction.handler({ url: "https://free-resource.com" }, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain("did not return 402");
  });

  it("fails when 402 body has no matching scheme", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 402,
        json: () =>
          Promise.resolve({
            x402Version: 1,
            accepts: [{ scheme: "other-scheme", price: "100" }],
          }),
      })
    );

    const ctx = createContext();
    const result = await marcPayAction.handler({ url: "https://api.example.com" }, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain("No matching FHE payment requirement");
  });

  it("fails when 402 body is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 402,
        json: () => Promise.resolve({ invalid: true }),
      })
    );

    const ctx = createContext();
    const result = await marcPayAction.handler({ url: "https://api.example.com" }, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Invalid 402 response");
  });

  it("handles transfer error in pay flow", async () => {
    mockConfidentialTransfer.mockRejectedValue(new Error("Transfer reverted"));

    const ctx = createContext();
    const result = await marcPayAction.handler({ url: "https://api.example.com" }, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Transfer reverted");
  });

  it("handles verifier error in pay flow", async () => {
    mockRecordPayment.mockRejectedValue(new Error("Nonce already used"));

    const ctx = createContext();
    const result = await marcPayAction.handler({ url: "https://api.example.com" }, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Nonce already used");
  });

  it("respects maxPayment cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 402,
        json: () =>
          Promise.resolve({
            x402Version: 1,
            accepts: [
              {
                scheme: "fhe-confidential-v1",
                price: "50000000",
                recipientAddress: VALID_ADDRESS_B,
              },
            ],
          }),
      })
    );

    const ctx = createContext();
    const result = await marcPayAction.handler({ url: "https://api.example.com", maxPayment: "1000000" }, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain("No matching FHE payment requirement");
  });

  it("fails when 402 body cannot be parsed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 402,
        json: () => Promise.reject(new Error("parse error")),
      })
    );

    const ctx = createContext();
    const result = await marcPayAction.handler({ url: "https://api.example.com" }, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Failed to parse 402 response");
  });
});

// ============================================================================
// Custom addresses
// ============================================================================

describe("custom addresses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApprove.mockResolvedValue(txReceipt("0xapprove"));
    mockWrap.mockResolvedValue(txReceipt("0xwrap"));
    mockBalanceOf.mockResolvedValue(1_000_000n);
    mockConfidentialBalanceOf.mockResolvedValue("0x" + "00".repeat(32));
  });

  it("uses custom addresses when provided", async () => {
    const customAddresses = {
      tokenAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      verifierAddress: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      usdcAddress: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    };
    const ctx = createContext({ addresses: customAddresses });

    await marcBalanceAction.handler({}, ctx);
    expect(mockBalanceOf).toHaveBeenCalled();
  });

  it("defaults to Sepolia addresses when not provided", async () => {
    const ctx = createContext();
    const result = await marcBalanceAction.handler({}, ctx);

    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Default export
// ============================================================================

describe("default export", () => {
  it("default export equals named marcPlugin export", async () => {
    const mod = await import("../src/index.js");
    expect(mod.default).toBe(mod.marcPlugin);
  });
});
