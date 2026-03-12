import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock fhe-x402-sdk BEFORE importing scripts
// ---------------------------------------------------------------------------

vi.mock("fhe-x402-sdk", () => ({
  TOKEN_ABI: [
    "function wrap(address to, uint256 amount) external",
    "function unwrap(address from, address to, externalEuint64 encryptedAmount, bytes calldata inputProof) external",
    "function confidentialTransfer(address to, externalEuint64 encryptedAmount, bytes calldata inputProof) external",
    "function confidentialBalanceOf(address account) external view returns (bytes32)",
    "function finalizeUnwrap(bytes32 burntAmount, uint64 cleartextAmount, bytes calldata decryptionProof) external",
  ],
  VERIFIER_ABI: ["function recordPayment(address server, bytes32 nonce, uint64 minPrice) external"],
}));

// Mock @zama-fhe/relayer-sdk — simulates createEncryptedInput().add64().encrypt()
const mockEncrypt = vi.fn().mockResolvedValue({
  handles: ["0x" + "ff".repeat(32)],
  inputProof: "0x" + "ee".repeat(64),
});
const mockAdd64 = vi.fn();
const mockCreateEncryptedInput = vi.fn().mockReturnValue({
  add64: mockAdd64,
  encrypt: mockEncrypt,
});

vi.mock("@zama-fhe/relayer-sdk/node", () => ({
  SepoliaConfig: { chainId: 11155111 },
  createInstance: vi.fn().mockResolvedValue({
    createEncryptedInput: mockCreateEncryptedInput,
  }),
}));

// Mock ethers
const mockWrap = vi.fn();
const mockUnwrap = vi.fn();
const mockConfidentialTransfer = vi.fn();
const mockRecordPayment = vi.fn();
const mockApprove = vi.fn();
const mockBalanceOf = vi.fn().mockResolvedValue(10_000_000n);
const mockConfidentialBalanceOf = vi.fn().mockResolvedValue("0x" + "00".repeat(32));
const mockFinalizeUnwrap = vi.fn();
const mockGetAddress = vi.fn().mockResolvedValue("0x1234567890abcdef1234567890abcdef12345678");
const mockGetBalance = vi.fn().mockResolvedValue(1_000_000_000_000_000n);
const mockGetTokenAddress = vi.fn().mockResolvedValue("0xE944754aa70d4924dc5d8E57774CDf21Df5e592D");

vi.mock("ethers", async () => {
  const actual = await vi.importActual("ethers");
  return {
    ...actual,
    Contract: vi.fn().mockImplementation((_addr: string, abi: any) => {
      const abiStr = JSON.stringify(abi);
      // USDC: has "approve" but NOT "wrap"
      if (abiStr.includes("approve") && !abiStr.includes("wrap")) {
        return {
          approve: mockApprove,
          balanceOf: mockBalanceOf,
        };
      }
      // Token: has "wrap"
      if (abiStr.includes("wrap")) {
        return {
          wrap: mockWrap,
          confidentialTransfer: mockConfidentialTransfer,
          unwrap: mockUnwrap,
          confidentialBalanceOf: mockConfidentialBalanceOf,
          finalizeUnwrap: mockFinalizeUnwrap,
          getAddress: mockGetTokenAddress,
        };
      }
      // Verifier: has "recordPayment"
      if (abiStr.includes("recordPayment")) {
        return {
          recordPayment: mockRecordPayment,
        };
      }
      return {};
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
import { run as runWrap } from "../scripts/wrap.js";
import { run as runPay } from "../scripts/pay.js";
import { run as runUnwrap } from "../scripts/unwrap.js";
import { run as runFinalizeUnwrap } from "../scripts/finalizeUnwrap.js";
import { run as runInfo } from "../scripts/info.js";

// ---------------------------------------------------------------------------
// Balance Tests
// ---------------------------------------------------------------------------

describe("balance script", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBalanceOf.mockResolvedValue(5_000_000n);
  });

  it("returns balance with no encrypted cUSDC", async () => {
    mockConfidentialBalanceOf.mockResolvedValue("0x" + "00".repeat(32));

    const raw = await runBalance();
    const data = JSON.parse(raw);

    expect(data.ok).toBe(true);
    expect(data.action).toBe("balance");
    expect(data.publicBalanceUSDC).toBe("5.00");
    expect(data.walletAddress).toBe("0x1234567890abcdef1234567890abcdef12345678");
    expect(data.hasEncryptedBalance).toBe(false);
    expect(data.note).toContain("No encrypted cUSDC balance detected");
  });

  it("returns balance with encrypted cUSDC handle", async () => {
    mockConfidentialBalanceOf.mockResolvedValue("0x" + "ab".repeat(32));

    const raw = await runBalance();
    const data = JSON.parse(raw);

    expect(data.ok).toBe(true);
    expect(data.action).toBe("balance");
    expect(data.publicBalanceUSDC).toBe("5.00");
    expect(data.hasEncryptedBalance).toBe(true);
    expect(data.encryptedBalanceHandle).toBe("0x" + "ab".repeat(32));
    expect(data.note).toContain("Exact amount requires KMS decryption");
  });

  it("handles zero balance", async () => {
    mockBalanceOf.mockResolvedValue(0n);

    const raw = await runBalance();
    const data = JSON.parse(raw);

    expect(data.ok).toBe(true);
    expect(data.publicBalanceUSDC).toBe("0.00");
  });

  it("handles error", async () => {
    mockBalanceOf.mockRejectedValueOnce(new Error("RPC timeout"));

    const raw = await runBalance();
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("RPC timeout");
  });
});

// ---------------------------------------------------------------------------
// Wrap Tests (USDC -> cUSDC, no FHE encryption)
// ---------------------------------------------------------------------------

describe("wrap script", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApprove.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({}),
    });
    mockWrap.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({
        hash: "0xabc123",
        blockNumber: 12345,
      }),
    });
  });

  it("wraps USDC successfully", async () => {
    const raw = await runWrap({ amount: "2" });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(true);
    expect(data.action).toBe("wrap");
    expect(data.amount).toBe("2");
    expect(data.txHash).toBe("0xabc123");
    expect(data.blockNumber).toBe(12345);
    expect(mockApprove).toHaveBeenCalled();
    expect(mockWrap).toHaveBeenCalledWith("0x1234567890abcdef1234567890abcdef12345678", 2_000_000n);
  });

  it("wraps fractional USDC", async () => {
    await runWrap({ amount: "0.5" });
    expect(mockWrap).toHaveBeenCalledWith("0x1234567890abcdef1234567890abcdef12345678", 500_000n);
  });

  it("fails when amount is missing", async () => {
    const raw = await runWrap({});
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("--amount is required");
  });

  it("fails when amount is negative", async () => {
    const raw = await runWrap({ amount: "-1" });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("Invalid amount");
  });

  it("fails when amount is not a number", async () => {
    const raw = await runWrap({ amount: "abc" });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("Invalid amount");
  });

  it("handles wrap error gracefully", async () => {
    mockWrap.mockRejectedValueOnce(new Error("Insufficient USDC balance"));

    const raw = await runWrap({ amount: "100" });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("Insufficient USDC balance");
  });
});

// ---------------------------------------------------------------------------
// Pay Tests (with fhevmjs encryption + verifier)
// ---------------------------------------------------------------------------

describe("pay script", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(data.verifierTxHash).toBe("0xverifier789");
    expect(data.nonce).toBeDefined();
    // Verify token.confidentialTransfer was called with encrypted handles from fhevmjs
    expect(mockConfidentialTransfer).toHaveBeenCalledWith(
      "0x1234567890abcdef1234567890abcdef12345678",
      "0x" + "ff".repeat(32),
      "0x" + "ee".repeat(64)
    );
    // Verify verifier.recordPayment was called
    expect(mockRecordPayment).toHaveBeenCalledWith(
      "0x1234567890abcdef1234567890abcdef12345678", // server (to)
      expect.any(String), // nonce
      1_000_000n // minPrice
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
    mockConfidentialTransfer.mockRejectedValueOnce(new Error("Execution reverted"));

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
// Unwrap Tests (cUSDC -> USDC, with fhevmjs encryption)
// ---------------------------------------------------------------------------

describe("unwrap script", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUnwrap.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({
        hash: "0x789xyz",
        blockNumber: 12348,
      }),
    });
  });

  it("encrypts and requests unwrap successfully", async () => {
    const raw = await runUnwrap({ amount: "1" });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(true);
    expect(data.action).toBe("unwrap_requested");
    expect(data.amount).toBe("1");
    expect(data.txHash).toBe("0x789xyz");
    expect(data.note).toContain("KMS");
    // Verify unwrap was called with encrypted handles
    expect(mockUnwrap).toHaveBeenCalledWith(
      "0x1234567890abcdef1234567890abcdef12345678",
      "0x1234567890abcdef1234567890abcdef12345678",
      "0x" + "ff".repeat(32),
      "0x" + "ee".repeat(64)
    );
  });

  it("calls fhevmjs createEncryptedInput for unwrap", async () => {
    await runUnwrap({ amount: "5" });
    expect(mockCreateEncryptedInput).toHaveBeenCalled();
    expect(mockAdd64).toHaveBeenCalledWith(5_000_000n);
    expect(mockEncrypt).toHaveBeenCalled();
  });

  it("fails when amount is missing", async () => {
    const raw = await runUnwrap({});
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("--amount is required");
  });

  it("fails with negative amount", async () => {
    const raw = await runUnwrap({ amount: "-1" });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("Invalid amount");
  });

  it("fails with non-numeric amount", async () => {
    const raw = await runUnwrap({ amount: "abc" });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("Invalid amount");
  });

  it("handles unwrap error gracefully", async () => {
    mockUnwrap.mockRejectedValueOnce(new Error("Insufficient cUSDC balance"));

    const raw = await runUnwrap({ amount: "1" });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("Insufficient cUSDC balance");
  });
});

// ---------------------------------------------------------------------------
// FinalizeUnwrap Tests (step 2 of unwrap)
// ---------------------------------------------------------------------------

describe("finalizeUnwrap script", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFinalizeUnwrap.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({
        hash: "0xfinalize123",
        blockNumber: 12349,
      }),
    });
  });

  it("finalizes unwrap successfully", async () => {
    const raw = await runFinalizeUnwrap({
      burntAmount: "0x" + "aa".repeat(32),
      cleartextAmount: "1000000",
      decryptionProof: "0x" + "bb".repeat(64),
    });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(true);
    expect(data.action).toBe("unwrap_finalized");
    expect(data.cleartextAmount).toBe("1000000");
    expect(data.txHash).toBe("0xfinalize123");
    expect(data.blockNumber).toBe(12349);
    expect(mockFinalizeUnwrap).toHaveBeenCalledWith("0x" + "aa".repeat(32), 1_000_000n, "0x" + "bb".repeat(64));
  });

  it("fails when burntAmount is missing", async () => {
    const raw = await runFinalizeUnwrap({
      cleartextAmount: "1000000",
      decryptionProof: "0xproof",
    });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("required");
  });

  it("fails when cleartextAmount is missing", async () => {
    const raw = await runFinalizeUnwrap({
      burntAmount: "0xburnt",
      decryptionProof: "0xproof",
    });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("required");
  });

  it("fails when decryptionProof is missing", async () => {
    const raw = await runFinalizeUnwrap({
      burntAmount: "0xburnt",
      cleartextAmount: "1000000",
    });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("required");
  });

  it("handles finalize error gracefully", async () => {
    mockFinalizeUnwrap.mockRejectedValueOnce(new Error("Decryption proof invalid"));

    const raw = await runFinalizeUnwrap({
      burntAmount: "0x" + "aa".repeat(32),
      cleartextAmount: "1000000",
      decryptionProof: "0x" + "bb".repeat(64),
    });
    const data = JSON.parse(raw);

    expect(data.ok).toBe(false);
    expect(data.error).toContain("Decryption proof invalid");
  });
});

// ---------------------------------------------------------------------------
// Info Tests
// ---------------------------------------------------------------------------

describe("info script", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns token, verifier and wallet info", async () => {
    const raw = await runInfo();
    const data = JSON.parse(raw);

    expect(data.ok).toBe(true);
    expect(data.action).toBe("info");
    expect(data.network).toBe("Ethereum Sepolia");
    expect(data.walletAddress).toBe("0x1234567890abcdef1234567890abcdef12345678");
    expect(data.tokenAddress).toBeDefined();
    expect(data.verifierAddress).toBeDefined();
    expect(data.poolAddress).toBeUndefined();
    expect(data.scheme).toBe("fhe-confidential-v1");
  });

  it("includes ETH balance", async () => {
    const raw = await runInfo();
    const data = JSON.parse(raw);

    expect(data.ok).toBe(true);
    expect(data.ethBalance).toBeDefined();
  });
});
