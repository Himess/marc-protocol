import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock fhe-x402-sdk BEFORE importing scripts
// ---------------------------------------------------------------------------

vi.mock("fhe-x402-sdk", () => ({
  POOL_ABI: [
    "function deposit(uint64 amount) external",
    "function pay(address to, externalEuint64 encryptedAmount, bytes calldata inputProof, uint64 minPrice, bytes32 nonce) external",
    "function requestWithdraw(externalEuint64 encryptedAmount, bytes calldata inputProof) external",
    "function isInitialized(address account) external view returns (bool)",
  ],
}));

// Mock fhevmjs — simulates real fhevmjs createEncryptedInput().add64().encrypt()
const mockEncrypt = vi.fn().mockResolvedValue({
  handles: ["0x" + "ff".repeat(32)],
  inputProof: "0x" + "ee".repeat(64),
});
const mockAdd64 = vi.fn();
const mockCreateEncryptedInput = vi.fn().mockReturnValue({
  add64: mockAdd64,
  encrypt: mockEncrypt,
});

vi.mock("fhevmjs", () => ({
  initFhevm: vi.fn().mockResolvedValue(undefined),
  createInstance: vi.fn().mockResolvedValue({
    createEncryptedInput: mockCreateEncryptedInput,
  }),
}));

// Mock ethers
const mockDeposit = vi.fn();
const mockPay = vi.fn();
const mockRequestWithdraw = vi.fn();
const mockIsInitialized = vi.fn().mockResolvedValue(true);
const mockApprove = vi.fn();
const mockBalanceOf = vi.fn().mockResolvedValue(10_000_000n);
const mockGetAddress = vi.fn().mockResolvedValue("0x1234567890abcdef1234567890abcdef12345678");
const mockGetBalance = vi.fn().mockResolvedValue(1_000_000_000_000_000n);
const mockGetPoolAddress = vi.fn().mockResolvedValue("0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73");

vi.mock("ethers", async () => {
  const actual = await vi.importActual("ethers");
  return {
    ...actual,
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
        isInitialized: mockIsInitialized,
        getAddress: mockGetPoolAddress,
      };
    }),
    JsonRpcProvider: vi.fn().mockImplementation(() => ({
      getBalance: mockGetBalance,
    })),
    Wallet: vi.fn().mockImplementation(() => ({
      getAddress: mockGetAddress,
    })),
  };
});

// Set env vars
process.env.PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";

import { run as runBalance } from "../scripts/balance.js";
import { run as runDeposit } from "../scripts/deposit.js";
import { run as runPay } from "../scripts/pay.js";
import { run as runWithdraw } from "../scripts/withdraw.js";
import { run as runInfo } from "../scripts/info.js";

// ---------------------------------------------------------------------------
// Balance Tests
// ---------------------------------------------------------------------------

describe("balance script", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsInitialized.mockResolvedValue(true);
    mockBalanceOf.mockResolvedValue(5_000_000n);
  });

  it("returns balance and init status", async () => {
    const raw = await runBalance();
    const data = JSON.parse(raw);

    expect(data.ok).toBe(true);
    expect(data.action).toBe("balance");
    expect(data.publicBalanceUSDC).toBe("5.00");
    expect(data.isInitialized).toBe(true);
    expect(data.walletAddress).toBe("0x1234567890abcdef1234567890abcdef12345678");
  });

  it("handles zero balance", async () => {
    mockBalanceOf.mockResolvedValue(0n);
    mockIsInitialized.mockResolvedValue(false);

    const raw = await runBalance();
    const data = JSON.parse(raw);

    expect(data.ok).toBe(true);
    expect(data.publicBalanceUSDC).toBe("0.00");
    expect(data.isInitialized).toBe(false);
  });

  it("handles error", async () => {
    mockIsInitialized.mockRejectedValueOnce(new Error("RPC timeout"));

    const raw = await runBalance();
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("RPC timeout");
  });
});

// ---------------------------------------------------------------------------
// Deposit Tests
// ---------------------------------------------------------------------------

describe("deposit script", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApprove.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({}),
    });
    mockDeposit.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({
        hash: "0xabc123",
        blockNumber: 12345,
      }),
    });
  });

  it("deposits USDC successfully", async () => {
    const raw = await runDeposit({ amount: "2" });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(true);
    expect(data.action).toBe("deposit");
    expect(data.amount).toBe("2");
    expect(data.txHash).toBe("0xabc123");
    expect(data.blockNumber).toBe(12345);
    expect(mockDeposit).toHaveBeenCalledWith(2_000_000n);
  });

  it("deposits fractional USDC", async () => {
    await runDeposit({ amount: "0.5" });
    expect(mockDeposit).toHaveBeenCalledWith(500_000n);
  });

  it("fails when amount is missing", async () => {
    const raw = await runDeposit({});
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("--amount is required");
  });

  it("fails when amount is negative", async () => {
    const raw = await runDeposit({ amount: "-1" });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("Invalid amount");
  });

  it("fails when amount is not a number", async () => {
    const raw = await runDeposit({ amount: "abc" });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("Invalid amount");
  });

  it("handles deposit error gracefully", async () => {
    mockDeposit.mockRejectedValueOnce(new Error("Insufficient USDC balance"));

    const raw = await runDeposit({ amount: "100" });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("Insufficient USDC balance");
  });
});

// ---------------------------------------------------------------------------
// Pay Tests (with fhevmjs encryption)
// ---------------------------------------------------------------------------

describe("pay script", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPay.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({
        hash: "0xdef456",
        blockNumber: 12346,
      }),
    });
  });

  it("encrypts and pays USDC successfully", async () => {
    const raw = await runPay({
      amount: "1",
      to: "0x1234567890abcdef1234567890abcdef12345678",
    });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(true);
    expect(data.action).toBe("pay");
    expect(data.amount).toBe("1");
    expect(data.to).toBe("0x1234567890abcdef1234567890abcdef12345678");
    expect(data.txHash).toBe("0xdef456");
    expect(data.nonce).toBeDefined();
    // Verify pool.pay was called with encrypted handles from fhevmjs
    expect(mockPay).toHaveBeenCalledWith(
      "0x1234567890abcdef1234567890abcdef12345678",
      "0x" + "ff".repeat(32),
      "0x" + "ee".repeat(64),
      1_000_000n,
      expect.any(String)
    );
  });

  it("calls fhevmjs createEncryptedInput with correct params", async () => {
    await runPay({
      amount: "2",
      to: "0x1234567890abcdef1234567890abcdef12345678",
    });
    expect(mockCreateEncryptedInput).toHaveBeenCalled();
    expect(mockAdd64).toHaveBeenCalledWith(2_000_000n);
    expect(mockEncrypt).toHaveBeenCalled();
  });

  it("fails when amount is missing", async () => {
    const raw = await runPay({
      to: "0x1234567890abcdef1234567890abcdef12345678",
    });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("required");
  });

  it("fails when to is missing", async () => {
    const raw = await runPay({ amount: "1" });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("required");
  });

  it("fails with invalid Ethereum address", async () => {
    const raw = await runPay({
      amount: "1",
      to: "not-an-address",
    });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("Invalid Ethereum address");
  });

  it("fails with too-short address", async () => {
    const raw = await runPay({
      amount: "1",
      to: "0x1234",
    });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("Invalid Ethereum address");
  });

  it("fails with invalid amount", async () => {
    const raw = await runPay({
      amount: "abc",
      to: "0x1234567890abcdef1234567890abcdef12345678",
    });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("Invalid amount");
  });

  it("handles pay error gracefully", async () => {
    mockPay.mockRejectedValueOnce(new Error("Execution reverted"));

    const raw = await runPay({
      amount: "1",
      to: "0x1234567890abcdef1234567890abcdef12345678",
    });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("Execution reverted");
  });
});

// ---------------------------------------------------------------------------
// Withdraw Tests (with fhevmjs encryption)
// ---------------------------------------------------------------------------

describe("withdraw script", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestWithdraw.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({
        hash: "0x789xyz",
        blockNumber: 12347,
      }),
    });
  });

  it("encrypts and requests withdrawal successfully", async () => {
    const raw = await runWithdraw({ amount: "1" });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(true);
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

  it("calls fhevmjs createEncryptedInput for withdrawal", async () => {
    await runWithdraw({ amount: "5" });
    expect(mockCreateEncryptedInput).toHaveBeenCalled();
    expect(mockAdd64).toHaveBeenCalledWith(5_000_000n);
    expect(mockEncrypt).toHaveBeenCalled();
  });

  it("fails when amount is missing", async () => {
    const raw = await runWithdraw({});
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("--amount is required");
  });

  it("fails with negative amount", async () => {
    const raw = await runWithdraw({ amount: "-1" });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("Invalid amount");
  });

  it("fails with non-numeric amount", async () => {
    const raw = await runWithdraw({ amount: "abc" });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("Invalid amount");
  });

  it("handles withdrawal error gracefully", async () => {
    mockRequestWithdraw.mockRejectedValueOnce(new Error("Already pending withdrawal"));

    const raw = await runWithdraw({ amount: "1" });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("Already pending withdrawal");
  });
});

// ---------------------------------------------------------------------------
// Info Tests
// ---------------------------------------------------------------------------

describe("info script", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsInitialized.mockResolvedValue(true);
  });

  it("returns pool and wallet info", async () => {
    const raw = await runInfo();
    const data = JSON.parse(raw);

    expect(data.ok).toBe(true);
    expect(data.action).toBe("info");
    expect(data.network).toBe("Ethereum Sepolia");
    expect(data.walletAddress).toBe("0x1234567890abcdef1234567890abcdef12345678");
    expect(data.poolAddress).toBeDefined();
    expect(data.scheme).toBe("fhe-confidential-v1");
  });

  it("includes ETH balance", async () => {
    const raw = await runInfo();
    const data = JSON.parse(raw);

    expect(data.ok).toBe(true);
    expect(data.ethBalance).toBeDefined();
  });
});
