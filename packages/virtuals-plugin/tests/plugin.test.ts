import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutableGameFunctionStatus } from "@virtuals-protocol/game";

// ---------------------------------------------------------------------------
// Mock ethers BEFORE importing plugin
// ---------------------------------------------------------------------------

const mockApprove = vi.fn();
const mockBalanceOf = vi.fn().mockResolvedValue(5_000_000n);
const mockWrap = vi.fn();
const mockConfidentialTransfer = vi.fn();
const mockUnwrap = vi.fn();
const mockFinalizeUnwrap = vi.fn();
const mockConfidentialBalanceOf = vi.fn();
const mockRecordPayment = vi.fn();
const mockGetAddress = vi.fn().mockResolvedValue("0x1234567890abcdef1234567890abcdef12345678");

vi.mock("ethers", () => ({
  JsonRpcProvider: vi.fn().mockImplementation(() => ({})),
  Wallet: vi.fn().mockImplementation(() => ({
    getAddress: mockGetAddress,
  })),
  Contract: vi.fn().mockImplementation((_addr: string, abi: any) => {
    const abiStr = JSON.stringify(abi);
    if (abiStr.includes("wrap")) {
      // Token contract (cUSDC / ERC-7984)
      return {
        wrap: mockWrap,
        confidentialTransfer: mockConfidentialTransfer,
        unwrap: mockUnwrap,
        finalizeUnwrap: mockFinalizeUnwrap,
        confidentialBalanceOf: mockConfidentialBalanceOf,
      };
    }
    if (abiStr.includes("recordPayment")) {
      // Verifier contract (nonce registry)
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

vi.mock("fhe-x402-sdk", () => ({
  TOKEN_ABI: [
    "function wrap(address to, uint256 amount) external",
    "function confidentialTransfer(address to, externalEuint64 encryptedAmount, bytes calldata inputProof) external",
    "function unwrap(address from, address to, externalEuint64 encryptedAmount, bytes calldata inputProof) external",
  ],
  VERIFIER_ABI: [
    "function recordPayment(address server, bytes32 nonce, uint64 minPrice) external",
  ],
}));

import { FhePlugin } from "../src/fhePlugin";

// ---------------------------------------------------------------------------
// fhevmjs mock -- simulates real fhevmjs createEncryptedInput().add64().encrypt()
// ---------------------------------------------------------------------------

function createMockFhevmInstance() {
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

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function createPlugin() {
  return new FhePlugin({
    credentials: {
      privateKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
      tokenAddress: "0xAABBCCDDEEFF00112233445566778899AABBCCDD",
      verifierAddress: "0x1122334455667788990011223344556677889900",
      fhevmInstance: createMockFhevmInstance(),
    },
  });
}

const noopLogger = (() => {}) as any;

// ---------------------------------------------------------------------------
// Constructor Tests
// ---------------------------------------------------------------------------

describe("FhePlugin constructor", () => {
  it("creates plugin with default options", () => {
    const plugin = createPlugin();
    expect(plugin).toBeDefined();
  });

  it("creates plugin with custom options", () => {
    const plugin = new FhePlugin({
      id: "custom_id",
      name: "Custom Name",
      description: "Custom desc",
      credentials: {
        privateKey: "0x01",
        tokenAddress: "0x1111111111111111111111111111111111111111",
        verifierAddress: "0x2222222222222222222222222222222222222222",
        rpcUrl: "https://custom-rpc.example.com",
        usdcAddress: "0x3333333333333333333333333333333333333333",
        chainId: 1,
        fhevmInstance: createMockFhevmInstance(),
      },
    });
    expect(plugin).toBeDefined();
  });

  it("throws if privateKey is missing", () => {
    expect(
      () =>
        new FhePlugin({
          credentials: {
            privateKey: "",
            tokenAddress: "0x1111111111111111111111111111111111111111",
            verifierAddress: "0x2222222222222222222222222222222222222222",
            fhevmInstance: createMockFhevmInstance(),
          },
        })
    ).toThrow("Private key is required");
  });

  it("throws if tokenAddress is missing", () => {
    expect(
      () =>
        new FhePlugin({
          credentials: {
            privateKey: "0x01",
            tokenAddress: "",
            verifierAddress: "0x2222222222222222222222222222222222222222",
            fhevmInstance: createMockFhevmInstance(),
          },
        })
    ).toThrow("Token address is required");
  });

  it("throws if verifierAddress is missing", () => {
    expect(
      () =>
        new FhePlugin({
          credentials: {
            privateKey: "0x01",
            tokenAddress: "0x1111111111111111111111111111111111111111",
            verifierAddress: "",
            fhevmInstance: createMockFhevmInstance(),
          },
        })
    ).toThrow("Verifier address is required");
  });

  it("throws if fhevmInstance is missing", () => {
    expect(
      () =>
        new FhePlugin({
          credentials: {
            privateKey: "0x01",
            tokenAddress: "0x1111111111111111111111111111111111111111",
            verifierAddress: "0x2222222222222222222222222222222222222222",
            fhevmInstance: null as any,
          },
        })
    ).toThrow("fhevmjs instance is required");
  });
});

// ---------------------------------------------------------------------------
// Wrap Tests (replaces deposit)
// ---------------------------------------------------------------------------

describe("fhe_wrap", () => {
  let plugin: FhePlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = createPlugin();
    mockApprove.mockResolvedValue({ wait: vi.fn().mockResolvedValue({}) });
    mockWrap.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({
        hash: "0xabc123",
        blockNumber: 12345,
      }),
    });
  });

  it("wraps USDC successfully", async () => {
    const fn = plugin.wrapFunction;
    const result = await fn.executable({ amount: "2" } as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Done);
    const data = JSON.parse(result.feedback);
    expect(data.action).toBe("wrap");
    expect(data.amount).toBe("2");
    expect(data.txHash).toBe("0xabc123");
    expect(data.blockNumber).toBe(12345);
    expect(mockApprove).toHaveBeenCalled();
    expect(mockWrap).toHaveBeenCalledWith(
      "0x1234567890abcdef1234567890abcdef12345678",
      2_000_000n
    );
  });

  it("wraps fractional USDC", async () => {
    const fn = plugin.wrapFunction;
    await fn.executable({ amount: "0.5" } as any, noopLogger);
    expect(mockWrap).toHaveBeenCalledWith(
      "0x1234567890abcdef1234567890abcdef12345678",
      500_000n
    );
  });

  it("fails when amount is missing", async () => {
    const fn = plugin.wrapFunction;
    const result = await fn.executable({ amount: undefined } as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("Amount is required");
  });

  it("fails when amount is negative", async () => {
    const fn = plugin.wrapFunction;
    const result = await fn.executable({ amount: "-1" } as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("Invalid amount");
  });

  it("fails when amount is zero", async () => {
    const fn = plugin.wrapFunction;
    const result = await fn.executable({ amount: "0" } as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("Invalid amount");
  });

  it("fails when amount is not a number", async () => {
    const fn = plugin.wrapFunction;
    const result = await fn.executable({ amount: "abc" } as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("Invalid amount");
  });

  it("handles wrap error gracefully", async () => {
    mockWrap.mockRejectedValue(new Error("Insufficient USDC balance"));

    const fn = plugin.wrapFunction;
    const result = await fn.executable({ amount: "100" } as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("Insufficient USDC balance");
  });
});

// ---------------------------------------------------------------------------
// Pay Tests (with real fhevmjs encryption flow)
// ---------------------------------------------------------------------------

describe("fhe_pay", () => {
  let plugin: FhePlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = createPlugin();
    mockConfidentialTransfer.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({
        hash: "0xdef456",
        blockNumber: 12346,
      }),
    });
    mockRecordPayment.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({
        hash: "0xverifier789",
        blockNumber: 12347,
      }),
    });
  });

  it("encrypts and pays USDC successfully", async () => {
    const fn = plugin.payFunction;
    const result = await fn.executable(
      {
        to: "0x1234567890abcdef1234567890abcdef12345678",
        amount: "1",
      } as any,
      noopLogger
    );

    expect(result.status).toBe(ExecutableGameFunctionStatus.Done);
    const data = JSON.parse(result.feedback);
    expect(data.action).toBe("pay");
    expect(data.amount).toBe("1");
    expect(data.txHash).toBe("0xdef456");
    expect(data.verifierTxHash).toBe("0xverifier789");
    expect(data.nonce).toBeDefined();
    // Verify token.confidentialTransfer was called with encrypted handles
    expect(mockConfidentialTransfer).toHaveBeenCalledWith(
      "0x1234567890abcdef1234567890abcdef12345678",
      "0x" + "ff".repeat(32), // encrypted handle from fhevmjs
      "0x" + "ee".repeat(64)  // input proof from fhevmjs
    );
    // Verify verifier.recordPayment was called (3 params: server, nonce, minPrice)
    expect(mockRecordPayment).toHaveBeenCalledWith(
      "0x1234567890abcdef1234567890abcdef12345678", // server (to)
      expect.any(String), // nonce
      1_000_000n // minPrice (rawAmount for 1 USDC)
    );
  });

  it("fails when to address is missing", async () => {
    const fn = plugin.payFunction;
    const result = await fn.executable(
      { to: undefined, amount: "1" } as any,
      noopLogger
    );

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("required");
  });

  it("fails when amount is missing", async () => {
    const fn = plugin.payFunction;
    const result = await fn.executable(
      { to: "0x1234567890abcdef1234567890abcdef12345678", amount: undefined } as any,
      noopLogger
    );

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("required");
  });

  it("fails when address is invalid", async () => {
    const fn = plugin.payFunction;
    const result = await fn.executable(
      { to: "not-an-address", amount: "1" } as any,
      noopLogger
    );

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("Invalid Ethereum address");
  });

  it("fails when amount is invalid", async () => {
    const fn = plugin.payFunction;
    const result = await fn.executable(
      {
        to: "0x1234567890abcdef1234567890abcdef12345678",
        amount: "-5",
      } as any,
      noopLogger
    );

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("Invalid amount");
  });

  it("handles pay error gracefully", async () => {
    mockConfidentialTransfer.mockRejectedValue(new Error("Execution reverted"));

    const fn = plugin.payFunction;
    const result = await fn.executable(
      {
        to: "0x1234567890abcdef1234567890abcdef12345678",
        amount: "1",
      } as any,
      noopLogger
    );

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("Execution reverted");
  });

  it("handles verifier error gracefully", async () => {
    mockRecordPayment.mockRejectedValue(new Error("Nonce already used"));

    const fn = plugin.payFunction;
    const result = await fn.executable(
      {
        to: "0x1234567890abcdef1234567890abcdef12345678",
        amount: "1",
      } as any,
      noopLogger
    );

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("Nonce already used");
  });
});

// ---------------------------------------------------------------------------
// Unwrap Tests (replaces withdraw/finalizeWithdraw/cancelWithdraw)
// ---------------------------------------------------------------------------

describe("fhe_unwrap", () => {
  let plugin: FhePlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = createPlugin();
    mockUnwrap.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({
        hash: "0x789xyz",
        blockNumber: 12348,
      }),
    });
  });

  it("encrypts and requests unwrap successfully", async () => {
    const fn = plugin.unwrapFunction;
    const result = await fn.executable({ amount: "1" } as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Done);
    const data = JSON.parse(result.feedback);
    expect(data.action).toBe("unwrap_requested");
    expect(data.amount).toBe("1");
    expect(data.txHash).toBe("0x789xyz");
    expect(data.note).toContain("KMS");
    // Verify token.unwrap was called with encrypted handles
    expect(mockUnwrap).toHaveBeenCalledWith(
      "0x1234567890abcdef1234567890abcdef12345678", // from (signer)
      "0x1234567890abcdef1234567890abcdef12345678", // to (signer)
      "0x" + "ff".repeat(32),
      "0x" + "ee".repeat(64)
    );
  });

  it("fails when amount is missing", async () => {
    const fn = plugin.unwrapFunction;
    const result = await fn.executable({ amount: undefined } as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("Amount is required");
  });

  it("fails when amount is invalid", async () => {
    const fn = plugin.unwrapFunction;
    const result = await fn.executable({ amount: "-1" } as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("Invalid amount");
  });

  it("handles unwrap error gracefully", async () => {
    mockUnwrap.mockRejectedValue(new Error("Insufficient encrypted balance"));

    const fn = plugin.unwrapFunction;
    const result = await fn.executable({ amount: "1" } as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("Insufficient encrypted balance");
  });
});

// ---------------------------------------------------------------------------
// Balance Tests
// ---------------------------------------------------------------------------

describe("fhe_balance", () => {
  let plugin: FhePlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = createPlugin();
    mockBalanceOf.mockResolvedValue(5_000_000n);
    mockConfidentialBalanceOf.mockResolvedValue("0x" + "aa".repeat(32));
  });

  it("returns public USDC balance and encrypted balance handle", async () => {
    const fn = plugin.balanceFunction;
    const result = await fn.executable({} as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Done);
    const data = JSON.parse(result.feedback);
    expect(data.action).toBe("balance");
    expect(data.publicBalanceUSDC).toBe("5.00");
    expect(data.walletAddress).toBe("0x1234567890abcdef1234567890abcdef12345678");
    expect(data.encryptedBalanceHandle).toBe("0x" + "aa".repeat(32));
    expect(data.hasEncryptedBalance).toBe(true);
    expect(data.note).toContain("KMS");
  });

  it("shows hasEncryptedBalance false when handle is zero", async () => {
    mockConfidentialBalanceOf.mockResolvedValue("0x" + "00".repeat(32));

    const fn = plugin.balanceFunction;
    const result = await fn.executable({} as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Done);
    const data = JSON.parse(result.feedback);
    expect(data.hasEncryptedBalance).toBe(false);
    expect(data.encryptedBalanceHandle).toBe("0x" + "00".repeat(32));
  });

  it("handles confidentialBalanceOf failure gracefully", async () => {
    mockConfidentialBalanceOf.mockRejectedValue(new Error("not available"));

    const fn = plugin.balanceFunction;
    const result = await fn.executable({} as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Done);
    const data = JSON.parse(result.feedback);
    expect(data.publicBalanceUSDC).toBe("5.00");
    expect(data.hasEncryptedBalance).toBe(false);
    expect(data.encryptedBalanceHandle).toBe("0x" + "00".repeat(32));
  });

  it("handles zero balance", async () => {
    mockBalanceOf.mockResolvedValue(0n);

    const fn = plugin.balanceFunction;
    const result = await fn.executable({} as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Done);
    const data = JSON.parse(result.feedback);
    expect(data.publicBalanceUSDC).toBe("0.00");
  });

  it("handles balance check error", async () => {
    mockBalanceOf.mockRejectedValue(new Error("RPC timeout"));

    const fn = plugin.balanceFunction;
    const result = await fn.executable({} as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("RPC timeout");
  });
});

// ---------------------------------------------------------------------------
// Finalize Unwrap Tests
// ---------------------------------------------------------------------------

describe("fhe_finalize_unwrap", () => {
  let plugin: FhePlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = createPlugin();
    mockFinalizeUnwrap.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({
        hash: "0xfinalize123",
        blockNumber: 12349,
      }),
    });
  });

  it("finalizes unwrap successfully", async () => {
    const fn = plugin.finalizeUnwrapFunction;
    const result = await fn.executable(
      {
        burntAmount: "0x" + "ab".repeat(32),
        cleartextAmount: "1000000",
        decryptionProof: "0x" + "cd".repeat(64),
      } as any,
      noopLogger
    );

    expect(result.status).toBe(ExecutableGameFunctionStatus.Done);
    const data = JSON.parse(result.feedback);
    expect(data.action).toBe("unwrap_finalized");
    expect(data.cleartextAmount).toBe("1000000");
    expect(data.txHash).toBe("0xfinalize123");
    expect(data.blockNumber).toBe(12349);
    expect(mockFinalizeUnwrap).toHaveBeenCalledWith(
      "0x" + "ab".repeat(32),
      1_000_000n,
      "0x" + "cd".repeat(64)
    );
  });

  it("fails when burntAmount is missing", async () => {
    const fn = plugin.finalizeUnwrapFunction;
    const result = await fn.executable(
      { burntAmount: undefined, cleartextAmount: "1000000", decryptionProof: "0xaa" } as any,
      noopLogger
    );

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("required");
  });

  it("fails when cleartextAmount is missing", async () => {
    const fn = plugin.finalizeUnwrapFunction;
    const result = await fn.executable(
      { burntAmount: "0xaa", cleartextAmount: undefined, decryptionProof: "0xbb" } as any,
      noopLogger
    );

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("required");
  });

  it("fails when decryptionProof is missing", async () => {
    const fn = plugin.finalizeUnwrapFunction;
    const result = await fn.executable(
      { burntAmount: "0xaa", cleartextAmount: "1000000", decryptionProof: undefined } as any,
      noopLogger
    );

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("required");
  });

  it("handles finalize error gracefully", async () => {
    mockFinalizeUnwrap.mockRejectedValue(new Error("KMS decryption not ready"));

    const fn = plugin.finalizeUnwrapFunction;
    const result = await fn.executable(
      {
        burntAmount: "0x" + "ab".repeat(32),
        cleartextAmount: "1000000",
        decryptionProof: "0x" + "cd".repeat(64),
      } as any,
      noopLogger
    );

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("KMS decryption not ready");
  });
});

// ---------------------------------------------------------------------------
// Info Tests
// ---------------------------------------------------------------------------

describe("fhe_info", () => {
  it("returns token, verifier, and wallet info", async () => {
    const plugin = createPlugin();
    const fn = plugin.infoFunction;
    const result = await fn.executable({} as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Done);
    const data = JSON.parse(result.feedback);
    expect(data.action).toBe("info");
    expect(data.network).toBe("Ethereum Sepolia");
    expect(data.tokenAddress).toBe("0xAABBCCDDEEFF00112233445566778899AABBCCDD");
    expect(data.verifierAddress).toBe("0x1122334455667788990011223344556677889900");
    expect(data.walletAddress).toBe("0x1234567890abcdef1234567890abcdef12345678");
    expect(data.scheme).toBe("fhe-confidential-v1");
  });
});

// ---------------------------------------------------------------------------
// Worker Tests
// ---------------------------------------------------------------------------

describe("getWorker", () => {
  it("returns a GameWorker with all 6 functions", () => {
    const plugin = createPlugin();
    const worker = plugin.getWorker();

    expect(worker).toBeDefined();
    expect(worker.id).toBe("fhe_x402_worker");
    expect(worker.name).toBe("FHE x402 Payment Worker");
    expect(worker.functions).toHaveLength(6);
  });

  it("allows custom functions override", () => {
    const plugin = createPlugin();
    const worker = plugin.getWorker({
      functions: [plugin.balanceFunction],
    });

    expect(worker.functions).toHaveLength(1);
  });
});
