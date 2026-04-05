import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mock ethers BEFORE importing tools
// ============================================================================

const mockApprove = vi.fn();
const mockBalanceOf = vi.fn().mockResolvedValue(5_000_000n);
const mockAllowance = vi.fn().mockResolvedValue(0n);
const mockWrap = vi.fn();
const mockConfidentialTransfer = vi.fn();
const mockUnwrap = vi.fn();
const mockConfidentialBalanceOf = vi.fn();
const mockRecordPayment = vi.fn();
const mockGetAddress = vi.fn().mockResolvedValue("0x1234567890abcdef1234567890abcdef12345678");
const mockSignMessage = vi.fn().mockResolvedValue("0xmocksignature");

vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  return {
    ...actual,
    JsonRpcProvider: vi.fn().mockImplementation(() => ({})),
    Wallet: vi.fn().mockImplementation(() => ({
      getAddress: mockGetAddress,
      signMessage: mockSignMessage,
    })),
    Contract: vi.fn().mockImplementation((_addr: string, abi: unknown) => {
      const abiStr = JSON.stringify(abi);
      if (abiStr.includes("wrap") && abiStr.includes("confidentialBalanceOf")) {
        // cUSDC (ConfidentialUSDC) contract
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
        allowance: mockAllowance,
      };
    }),
    isAddress: (addr: string) => /^0x[0-9a-fA-F]{40}$/.test(addr),
    parseUnits: actual.parseUnits,
    formatUnits: actual.formatUnits,
    ethers: {
      hexlify: vi.fn().mockReturnValue("0x" + "ab".repeat(32)),
      randomBytes: vi.fn().mockReturnValue(new Uint8Array(32)),
    },
  };
});

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { wrapUsdc } from "../src/tools/wrap.js";
import { unwrapCusdc } from "../src/tools/unwrap.js";
import { confidentialTransfer } from "../src/tools/transfer.js";
import { getBalance } from "../src/tools/balance.js";
import { payX402 } from "../src/tools/pay.js";
import { protocolInfo } from "../src/tools/info.js";
import { getChainConfig, CHAINS } from "../src/config.js";
import type { ChainConfig } from "../src/config.js";

// ============================================================================
// Test Fixtures
// ============================================================================

const SEPOLIA_CONFIG = getChainConfig(11155111);

function createMockWallet(): any {
  return {
    getAddress: mockGetAddress,
    signMessage: mockSignMessage,
  };
}

function createMockFhevmInstance(): any {
  return {
    createEncryptedInput: vi.fn().mockReturnValue({
      add64: vi.fn(),
      addAddress: vi.fn(),
      encrypt: vi.fn().mockResolvedValue({
        handles: ["0x" + "cc".repeat(32)],
        inputProof: "0x" + "dd".repeat(64),
      }),
    }),
  };
}

const mockTxReceipt = { status: 1, hash: "0x" + "aa".repeat(32) };
const mockTx = { hash: "0x" + "aa".repeat(32), wait: vi.fn().mockResolvedValue(mockTxReceipt) };

// ============================================================================
// Tests
// ============================================================================

describe("config", () => {
  it("should return Sepolia config for chainId 11155111", () => {
    const config = getChainConfig(11155111);
    expect(config.chainId).toBe(11155111);
    expect(config.name).toBe("Ethereum Sepolia");
    expect(config.contracts.tokenAddress).toBe("0xE944754aa70d4924dc5d8E57774CDf21Df5e592D");
    expect(config.contracts.verifierAddress).toBe("0x4503A7aee235aBD10e6064BBa8E14235fdF041f4");
    expect(config.contracts.usdcAddress).toBe("0xc89e913676B034f8b38E49f7508803d1cDEC9F4f");
  });

  it("should throw for unsupported chainId", () => {
    expect(() => getChainConfig(999999)).toThrow("Unsupported chainId: 999999");
  });
});

describe("wrap_usdc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAllowance.mockResolvedValue(0n);
    mockApprove.mockResolvedValue(mockTx);
    mockWrap.mockResolvedValue(mockTx);
  });

  it("should wrap USDC into cUSDC with approval", async () => {
    const wallet = createMockWallet();
    const result = await wrapUsdc(wallet, SEPOLIA_CONFIG, "1.50");

    expect(result).toContain("Wrapped 1.50 USDC into cUSDC");
    expect(result).toContain("1500000");
    expect(result).toContain("Wrap TX:");
  });

  it("should skip approval if allowance is sufficient", async () => {
    mockAllowance.mockResolvedValue(2_000_000n);
    const wallet = createMockWallet();
    const result = await wrapUsdc(wallet, SEPOLIA_CONFIG, "1.00");

    expect(result).toContain("Wrapped 1.00 USDC");
    expect(result).not.toContain("Approve TX:");
  });

  it("should reject zero amount", async () => {
    const wallet = createMockWallet();
    await expect(wrapUsdc(wallet, SEPOLIA_CONFIG, "0")).rejects.toThrow("Amount must be greater than 0");
  });

  it("should reject negative amount", async () => {
    const wallet = createMockWallet();
    await expect(wrapUsdc(wallet, SEPOLIA_CONFIG, "-5")).rejects.toThrow();
  });
});

describe("unwrap_cusdc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUnwrap.mockResolvedValue(mockTx);
  });

  it("should initiate unwrap with FHE encryption", async () => {
    const wallet = createMockWallet();
    const fhevm = createMockFhevmInstance();
    const result = await unwrapCusdc(wallet, SEPOLIA_CONFIG, "2.00", fhevm);

    expect(result).toContain("Unwrap initiated for 2.00 cUSDC");
    expect(result).toContain("2-step process");
    expect(result).toContain("Step 1 TX:");
  });

  it("should fail without FHE instance", async () => {
    const wallet = createMockWallet();
    await expect(unwrapCusdc(wallet, SEPOLIA_CONFIG, "1.00", null)).rejects.toThrow("FHE instance not initialized");
  });

  it("should reject zero amount", async () => {
    const wallet = createMockWallet();
    const fhevm = createMockFhevmInstance();
    await expect(unwrapCusdc(wallet, SEPOLIA_CONFIG, "0", fhevm)).rejects.toThrow("Amount must be greater than 0");
  });
});

describe("confidential_transfer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfidentialTransfer.mockResolvedValue(mockTx);
  });

  it("should send encrypted transfer", async () => {
    const wallet = createMockWallet();
    const fhevm = createMockFhevmInstance();
    const result = await confidentialTransfer(
      wallet,
      SEPOLIA_CONFIG,
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      "5.00",
      fhevm
    );

    expect(result).toContain("Confidential transfer sent");
    expect(result).toContain("5.00 cUSDC");
    expect(result).toContain("FHE-encrypted");
  });

  it("should reject invalid recipient address", async () => {
    const wallet = createMockWallet();
    const fhevm = createMockFhevmInstance();
    await expect(confidentialTransfer(wallet, SEPOLIA_CONFIG, "not-an-address", "1.00", fhevm)).rejects.toThrow(
      "Invalid recipient address"
    );
  });

  it("should fail without FHE instance", async () => {
    const wallet = createMockWallet();
    await expect(
      confidentialTransfer(wallet, SEPOLIA_CONFIG, "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", "1.00", null)
    ).rejects.toThrow("FHE instance not initialized");
  });

  it("should reject zero amount", async () => {
    const wallet = createMockWallet();
    const fhevm = createMockFhevmInstance();
    await expect(
      confidentialTransfer(wallet, SEPOLIA_CONFIG, "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", "0", fhevm)
    ).rejects.toThrow("Amount must be greater than 0");
  });
});

describe("get_balance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBalanceOf.mockResolvedValue(10_000_000n);
    mockConfidentialBalanceOf.mockResolvedValue("0x" + "ff".repeat(32));
  });

  it("should return balances for connected wallet", async () => {
    const wallet = createMockWallet();
    const result = await getBalance(wallet, SEPOLIA_CONFIG);

    expect(result).toContain("Balances for");
    expect(result).toContain("USDC (cleartext):");
    expect(result).toContain("cUSDC (encrypted):");
    expect(result).toContain("10.0");
  });

  it("should return balances for specific address", async () => {
    const wallet = createMockWallet();
    const result = await getBalance(wallet, SEPOLIA_CONFIG, "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");

    expect(result).toContain("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
  });

  it("should reject invalid address", async () => {
    const wallet = createMockWallet();
    await expect(getBalance(wallet, SEPOLIA_CONFIG, "bad")).rejects.toThrow("Invalid address");
  });

  it("should show no encrypted balance when handle is zero", async () => {
    mockConfidentialBalanceOf.mockResolvedValue("0x" + "00".repeat(32));
    const wallet = createMockWallet();
    const result = await getBalance(wallet, SEPOLIA_CONFIG);

    expect(result).toContain("0 (no encrypted balance)");
    expect(result).toContain("wrap_usdc");
  });
});

describe("pay_x402", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfidentialTransfer.mockResolvedValue(mockTx);
    mockRecordPayment.mockResolvedValue(mockTx);
  });

  it("should handle non-402 response", async () => {
    // Mock global fetch to return 200
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("OK", { status: 200, statusText: "OK" }));

    try {
      const wallet = createMockWallet();
      const fhevm = createMockFhevmInstance();
      const result = await payX402(wallet, SEPOLIA_CONFIG, "https://example.com/api", "GET", fhevm);

      expect(result).toContain("200");
      expect(result).toContain("no payment required");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should complete full 402 payment flow", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;

    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call: return 402
        return Promise.resolve(
          new Response(
            JSON.stringify({
              x402Version: 1,
              accepts: [
                {
                  scheme: "fhe-confidential-v1",
                  network: "eip155:11155111",
                  chainId: 11155111,
                  price: "1000000",
                  asset: "USDC",
                  tokenAddress: "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D",
                  verifierAddress: "0x4503A7aee235aBD10e6064BBa8E14235fdF041f4",
                  recipientAddress: "0xrecipient0000000000000000000000000000000",
                  maxTimeoutSeconds: 300,
                },
              ],
              resource: { url: "https://example.com/api", method: "GET" },
            }),
            { status: 402, statusText: "Payment Required" }
          )
        );
      }
      // Second call: return 200 with data
      return Promise.resolve(
        new Response(JSON.stringify({ data: "premium content" }), {
          status: 200,
          statusText: "OK",
        })
      );
    });

    try {
      const wallet = createMockWallet();
      const fhevm = createMockFhevmInstance();
      const result = await payX402(wallet, SEPOLIA_CONFIG, "https://example.com/api", "GET", fhevm);

      expect(result).toContain("x402 payment completed");
      expect(result).toContain("1.000000 USDC");
      expect(result).toContain("Transfer TX:");
      expect(result).toContain("Verifier TX:");
      expect(result).toContain("premium content");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should fail without FHE instance on 402 response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          x402Version: 1,
          accepts: [{ scheme: "fhe-confidential-v1", price: "1000000" }],
          resource: { url: "https://example.com/api", method: "GET" },
        }),
        { status: 402, statusText: "Payment Required" }
      )
    );

    try {
      const wallet = createMockWallet();
      await expect(payX402(wallet, SEPOLIA_CONFIG, "https://example.com/api", "GET", null)).rejects.toThrow(
        "FHE instance not initialized"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should fail if no matching FHE scheme in 402", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          x402Version: 1,
          accepts: [{ scheme: "some-other-scheme" }],
          resource: { url: "https://example.com/api", method: "GET" },
        }),
        { status: 402, statusText: "Payment Required" }
      )
    );

    try {
      const wallet = createMockWallet();
      const fhevm = createMockFhevmInstance();
      await expect(payX402(wallet, SEPOLIA_CONFIG, "https://example.com/api", "GET", fhevm)).rejects.toThrow(
        "No matching FHE payment scheme found"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("protocol_info", () => {
  it("should return protocol configuration", () => {
    const result = protocolInfo(SEPOLIA_CONFIG, "0x1234567890abcdef1234567890abcdef12345678");

    expect(result).toContain("MARC Protocol");
    expect(result).toContain("1.0.0");
    expect(result).toContain("fhe-confidential-v1");
    expect(result).toContain("Ethereum Sepolia");
    expect(result).toContain("11155111");
    expect(result).toContain("0xE944754aa70d4924dc5d8E57774CDf21Df5e592D");
    expect(result).toContain("0x4503A7aee235aBD10e6064BBa8E14235fdF041f4");
    expect(result).toContain("0xc89e913676B034f8b38E49f7508803d1cDEC9F4f");
    expect(result).toContain("0.1%");
    expect(result).toContain("0.01 USDC");
  });

  it("should include wallet address", () => {
    const result = protocolInfo(SEPOLIA_CONFIG, "0xMyWallet");
    expect(result).toContain("0xMyWallet");
  });

  it("should list all available tools", () => {
    const result = protocolInfo(SEPOLIA_CONFIG, "0x0");
    expect(result).toContain("wrap_usdc");
    expect(result).toContain("unwrap_cusdc");
    expect(result).toContain("confidential_transfer");
    expect(result).toContain("get_balance");
    expect(result).toContain("pay_x402");
    expect(result).toContain("protocol_info");
  });
});
