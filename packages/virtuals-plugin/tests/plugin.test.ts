import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutableGameFunctionStatus } from "@virtuals-protocol/game";

// ---------------------------------------------------------------------------
// Mock ethers BEFORE importing plugin
// ---------------------------------------------------------------------------

const mockApprove = vi.fn();
const mockDeposit = vi.fn();
const mockPay = vi.fn();
const mockRequestWithdraw = vi.fn();
const mockFinalizeWithdraw = vi.fn();
const mockCancelWithdraw = vi.fn();
const mockIsInitialized = vi.fn().mockResolvedValue(true);
const mockBalanceOf = vi.fn().mockResolvedValue(5_000_000n);
const mockGetAddress = vi.fn().mockResolvedValue("0x1234567890abcdef1234567890abcdef12345678");

vi.mock("ethers", () => ({
  JsonRpcProvider: vi.fn().mockImplementation(() => ({})),
  Wallet: vi.fn().mockImplementation(() => ({
    getAddress: mockGetAddress,
  })),
  Contract: vi.fn().mockImplementation((_addr: string, abi: any) => {
    const abiStr = JSON.stringify(abi);
    if (abiStr.includes("approve")) {
      return {
        approve: mockApprove,
        balanceOf: mockBalanceOf,
      };
    }
    return {
      deposit: mockDeposit,
      pay: mockPay,
      requestWithdraw: mockRequestWithdraw,
      finalizeWithdraw: mockFinalizeWithdraw,
      cancelWithdraw: mockCancelWithdraw,
      isInitialized: mockIsInitialized,
    };
  }),
  ethers: {
    hexlify: vi.fn().mockReturnValue("0x" + "ab".repeat(32)),
    randomBytes: vi.fn().mockReturnValue(new Uint8Array(32)),
    ZeroHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
  },
}));

vi.mock("fhe-x402-sdk", () => ({
  POOL_ABI: [
    "function deposit(uint64 amount) external",
    "function pay(address to, externalEuint64 encryptedAmount, bytes calldata inputProof, uint64 minPrice, bytes32 nonce, bytes32 memo) external",
    "function requestWithdraw(externalEuint64 encryptedAmount, bytes calldata inputProof) external",
    "function cancelWithdraw() external",
    "function finalizeWithdraw(uint64 clearAmount, bytes calldata decryptionProof) external",
    "function isInitialized(address account) external view returns (bool)",
  ],
}));

import { FhePlugin } from "../src/fhePlugin";

// ---------------------------------------------------------------------------
// fhevmjs mock — simulates real fhevmjs createEncryptedInput().add64().encrypt()
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
      poolAddress: "0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73",
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
        poolAddress: "0x1111111111111111111111111111111111111111",
        rpcUrl: "https://custom-rpc.example.com",
        usdcAddress: "0x2222222222222222222222222222222222222222",
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
            poolAddress: "0x1111111111111111111111111111111111111111",
            fhevmInstance: createMockFhevmInstance(),
          },
        })
    ).toThrow("Private key is required");
  });

  it("throws if poolAddress is missing", () => {
    expect(
      () =>
        new FhePlugin({
          credentials: {
            privateKey: "0x01",
            poolAddress: "",
            fhevmInstance: createMockFhevmInstance(),
          },
        })
    ).toThrow("Pool address is required");
  });

  it("throws if fhevmInstance is missing", () => {
    expect(
      () =>
        new FhePlugin({
          credentials: {
            privateKey: "0x01",
            poolAddress: "0x1111111111111111111111111111111111111111",
            fhevmInstance: null as any,
          },
        })
    ).toThrow("fhevmjs instance is required");
  });
});

// ---------------------------------------------------------------------------
// Deposit Tests
// ---------------------------------------------------------------------------

describe("fhe_deposit", () => {
  let plugin: FhePlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = createPlugin();
    mockApprove.mockResolvedValue({ wait: vi.fn().mockResolvedValue({}) });
    mockDeposit.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({
        hash: "0xabc123",
        blockNumber: 12345,
      }),
    });
  });

  it("deposits USDC successfully", async () => {
    const fn = plugin.depositFunction;
    const result = await fn.executable({ amount: "2" } as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Done);
    const data = JSON.parse(result.feedback);
    expect(data.action).toBe("deposit");
    expect(data.amount).toBe("2");
    expect(data.txHash).toBe("0xabc123");
    expect(data.blockNumber).toBe(12345);
    expect(mockApprove).toHaveBeenCalled();
    expect(mockDeposit).toHaveBeenCalledWith(2_000_000n);
  });

  it("deposits fractional USDC", async () => {
    const fn = plugin.depositFunction;
    await fn.executable({ amount: "0.5" } as any, noopLogger);
    expect(mockDeposit).toHaveBeenCalledWith(500_000n);
  });

  it("fails when amount is missing", async () => {
    const fn = plugin.depositFunction;
    const result = await fn.executable({ amount: undefined } as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("Amount is required");
  });

  it("fails when amount is negative", async () => {
    const fn = plugin.depositFunction;
    const result = await fn.executable({ amount: "-1" } as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("Invalid amount");
  });

  it("fails when amount is zero", async () => {
    const fn = plugin.depositFunction;
    const result = await fn.executable({ amount: "0" } as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("Invalid amount");
  });

  it("fails when amount is not a number", async () => {
    const fn = plugin.depositFunction;
    const result = await fn.executable({ amount: "abc" } as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("Invalid amount");
  });

  it("handles deposit error gracefully", async () => {
    mockDeposit.mockRejectedValue(new Error("Insufficient USDC balance"));

    const fn = plugin.depositFunction;
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
    mockPay.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({
        hash: "0xdef456",
        blockNumber: 12346,
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
    expect(data.nonce).toBeDefined();
    // Verify pool.pay was called with encrypted handles (not placeholder zeros)
    expect(mockPay).toHaveBeenCalledWith(
      "0x1234567890abcdef1234567890abcdef12345678",
      "0x" + "ff".repeat(32), // encrypted handle from fhevmjs
      "0x" + "ee".repeat(64), // input proof from fhevmjs
      1_000_000n,
      expect.any(String),
      "0x0000000000000000000000000000000000000000000000000000000000000000" // memo (ethers.ZeroHash)
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
    mockPay.mockRejectedValue(new Error("Execution reverted"));

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
});

// ---------------------------------------------------------------------------
// Withdraw Tests (with real fhevmjs encryption flow)
// ---------------------------------------------------------------------------

describe("fhe_withdraw", () => {
  let plugin: FhePlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = createPlugin();
    mockRequestWithdraw.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({
        hash: "0x789xyz",
        blockNumber: 12347,
      }),
    });
  });

  it("encrypts and requests withdrawal successfully", async () => {
    const fn = plugin.withdrawFunction;
    const result = await fn.executable({ amount: "1" } as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Done);
    const data = JSON.parse(result.feedback);
    expect(data.action).toBe("withdraw_requested");
    expect(data.amount).toBe("1");
    expect(data.txHash).toBe("0x789xyz");
    expect(data.note).toContain("KMS");
    // Verify requestWithdraw was called with encrypted handles
    expect(mockRequestWithdraw).toHaveBeenCalledWith(
      "0x" + "ff".repeat(32),
      "0x" + "ee".repeat(64)
    );
  });

  it("fails when amount is missing", async () => {
    const fn = plugin.withdrawFunction;
    const result = await fn.executable({ amount: undefined } as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("Amount is required");
  });

  it("fails when amount is invalid", async () => {
    const fn = plugin.withdrawFunction;
    const result = await fn.executable({ amount: "-1" } as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("Invalid amount");
  });

  it("handles withdrawal error gracefully", async () => {
    mockRequestWithdraw.mockRejectedValue(new Error("Already pending withdrawal"));

    const fn = plugin.withdrawFunction;
    const result = await fn.executable({ amount: "1" } as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("Already pending withdrawal");
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
    mockIsInitialized.mockResolvedValue(true);
    mockBalanceOf.mockResolvedValue(5_000_000n);
  });

  it("returns balance and init status", async () => {
    const fn = plugin.balanceFunction;
    const result = await fn.executable({} as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Done);
    const data = JSON.parse(result.feedback);
    expect(data.action).toBe("balance");
    expect(data.publicBalanceUSDC).toBe("5.00");
    expect(data.isInitialized).toBe(true);
    expect(data.walletAddress).toBe("0x1234567890abcdef1234567890abcdef12345678");
  });

  it("handles zero balance", async () => {
    mockBalanceOf.mockResolvedValue(0n);
    mockIsInitialized.mockResolvedValue(false);

    const fn = plugin.balanceFunction;
    const result = await fn.executable({} as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Done);
    const data = JSON.parse(result.feedback);
    expect(data.publicBalanceUSDC).toBe("0.00");
    expect(data.isInitialized).toBe(false);
  });

  it("handles balance check error", async () => {
    mockIsInitialized.mockRejectedValue(new Error("RPC timeout"));

    const fn = plugin.balanceFunction;
    const result = await fn.executable({} as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Failed);
    expect(result.feedback).toContain("RPC timeout");
  });
});

// ---------------------------------------------------------------------------
// Info Tests
// ---------------------------------------------------------------------------

describe("fhe_info", () => {
  it("returns pool and wallet info", async () => {
    const plugin = createPlugin();
    const fn = plugin.infoFunction;
    const result = await fn.executable({} as any, noopLogger);

    expect(result.status).toBe(ExecutableGameFunctionStatus.Done);
    const data = JSON.parse(result.feedback);
    expect(data.action).toBe("info");
    expect(data.network).toBe("Ethereum Sepolia");
    expect(data.poolAddress).toBe("0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73");
    expect(data.walletAddress).toBe("0x1234567890abcdef1234567890abcdef12345678");
    expect(data.scheme).toBe("fhe-confidential-v1");
  });
});

// ---------------------------------------------------------------------------
// Worker Tests
// ---------------------------------------------------------------------------

describe("getWorker", () => {
  it("returns a GameWorker with all 7 functions", () => {
    const plugin = createPlugin();
    const worker = plugin.getWorker();

    expect(worker).toBeDefined();
    expect(worker.id).toBe("fhe_x402_worker");
    expect(worker.name).toBe("FHE x402 Payment Worker");
    expect(worker.functions).toHaveLength(7);
  });

  it("allows custom functions override", () => {
    const plugin = createPlugin();
    const worker = plugin.getWorker({
      functions: [plugin.balanceFunction],
    });

    expect(worker.functions).toHaveLength(1);
  });
});
