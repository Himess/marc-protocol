import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mock ethers BEFORE importing provider
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

// ============================================================================
// Import the provider after mocks
// ============================================================================

import {
  MarcFheProvider,
  MarcProviderError,
  MARC_SEPOLIA_ADDRESSES,
  MARC_MAINNET_ADDRESSES,
  TOKEN_ABI,
  VERIFIER_ABI,
  USDC_ABI,
} from "../src/index.js";
import type {
  Signer,
  FhevmInstance,
  WrapResult,
  UnwrapResult,
  TransferResult,
  BalanceResult,
  RecordPaymentResult,
} from "../src/index.js";

// ============================================================================
// Helpers
// ============================================================================

const VALID_ADDRESS_A = "0x1234567890abcdef1234567890abcdef12345678";
const VALID_ADDRESS_B = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const VALID_TOKEN = MARC_SEPOLIA_ADDRESSES.tokenAddress;
const VALID_VERIFIER = MARC_SEPOLIA_ADDRESSES.verifierAddress;
const VALID_USDC = MARC_SEPOLIA_ADDRESSES.usdcAddress;
const VALID_NONCE = "0x" + "ab".repeat(32);

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

function createProvider(): MarcFheProvider {
  return new MarcFheProvider({ chainId: 11155111 });
}

function mockTxReceipt(hash: string, blockNumber = 12345) {
  return {
    hash,
    blockNumber,
    status: 1,
    wait: vi.fn().mockResolvedValue({ hash, blockNumber, status: 1 }),
  };
}

// ============================================================================
// Constructor Tests
// ============================================================================

describe("MarcFheProvider constructor", () => {
  it("creates provider with default config", () => {
    const provider = new MarcFheProvider();
    expect(provider).toBeDefined();
  });

  it("creates provider with custom chainId", () => {
    const provider = new MarcFheProvider({ chainId: 1 });
    expect(provider).toBeDefined();
  });

  it("creates provider with rpcUrl", () => {
    const provider = new MarcFheProvider({ rpcUrl: "https://rpc.example.com" });
    expect(provider).toBeDefined();
  });
});

// ============================================================================
// Exported constants
// ============================================================================

describe("exported constants", () => {
  it("MARC_SEPOLIA_ADDRESSES has all fields", () => {
    expect(MARC_SEPOLIA_ADDRESSES.tokenAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(MARC_SEPOLIA_ADDRESSES.verifierAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(MARC_SEPOLIA_ADDRESSES.usdcAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("MARC_MAINNET_ADDRESSES has empty tokenAddress and verifierAddress", () => {
    expect(MARC_MAINNET_ADDRESSES.tokenAddress).toBe("");
    expect(MARC_MAINNET_ADDRESSES.verifierAddress).toBe("");
    expect(MARC_MAINNET_ADDRESSES.usdcAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("TOKEN_ABI includes key functions", () => {
    const abiStr = TOKEN_ABI.join(" ");
    expect(abiStr).toContain("confidentialTransfer");
    expect(abiStr).toContain("wrap");
    expect(abiStr).toContain("unwrap");
    expect(abiStr).toContain("confidentialBalanceOf");
  });

  it("VERIFIER_ABI includes key functions", () => {
    const abiStr = VERIFIER_ABI.join(" ");
    expect(abiStr).toContain("recordPayment");
    expect(abiStr).toContain("usedNonces");
    expect(abiStr).toContain("payAndRecord");
    expect(abiStr).toContain("recordBatchPayment");
  });

  it("USDC_ABI includes approve and balanceOf", () => {
    const abiStr = USDC_ABI.join(" ");
    expect(abiStr).toContain("approve");
    expect(abiStr).toContain("balanceOf");
  });
});

// ============================================================================
// wrapUsdc Tests
// ============================================================================

describe("wrapUsdc", () => {
  let provider: MarcFheProvider;
  let signer: Signer;
  let fhevm: FhevmInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = createProvider();
    signer = createMockSigner();
    fhevm = createMockFhevmInstance();

    mockApprove.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({ hash: "0xapprove", status: 1 }),
    });
    mockWrap.mockResolvedValue({
      hash: "0xwrap123",
      wait: vi.fn().mockResolvedValue({ hash: "0xwrap123", blockNumber: 100, status: 1 }),
    });
  });

  it("wraps USDC successfully", async () => {
    const result = await provider.wrapUsdc(signer, fhevm, {
      amount: 1_000_000n,
      tokenAddress: VALID_TOKEN,
      usdcAddress: VALID_USDC,
    });

    expect(result.action).toBe("wrap");
    expect(result.txHash).toBe("0xwrap123");
    expect(result.amount).toBe("1000000");
    expect(result.to).toBe(VALID_ADDRESS_A);
    expect(mockApprove).toHaveBeenCalledWith(VALID_TOKEN, 1_000_000n);
    expect(mockWrap).toHaveBeenCalledWith(VALID_ADDRESS_A, 1_000_000n);
  });

  it("wraps USDC to custom recipient", async () => {
    const result = await provider.wrapUsdc(signer, fhevm, {
      amount: 500_000n,
      to: VALID_ADDRESS_B,
      tokenAddress: VALID_TOKEN,
      usdcAddress: VALID_USDC,
    });

    expect(result.to).toBe(VALID_ADDRESS_B);
    expect(mockWrap).toHaveBeenCalledWith(VALID_ADDRESS_B, 500_000n);
  });

  it("throws on zero amount", async () => {
    await expect(
      provider.wrapUsdc(signer, fhevm, {
        amount: 0n,
        tokenAddress: VALID_TOKEN,
        usdcAddress: VALID_USDC,
      })
    ).rejects.toThrow("must be > 0");
  });

  it("throws on negative amount", async () => {
    await expect(
      provider.wrapUsdc(signer, fhevm, {
        amount: -1n,
        tokenAddress: VALID_TOKEN,
        usdcAddress: VALID_USDC,
      })
    ).rejects.toThrow("must be > 0");
  });

  it("throws on zero tokenAddress", async () => {
    await expect(
      provider.wrapUsdc(signer, fhevm, {
        amount: 1_000_000n,
        tokenAddress: "0x0000000000000000000000000000000000000000",
        usdcAddress: VALID_USDC,
      })
    ).rejects.toThrow("Invalid tokenAddress");
  });

  it("throws on invalid usdcAddress", async () => {
    await expect(
      provider.wrapUsdc(signer, fhevm, {
        amount: 1_000_000n,
        tokenAddress: VALID_TOKEN,
        usdcAddress: "not-an-address",
      })
    ).rejects.toThrow("Invalid usdcAddress");
  });

  it("throws on empty tokenAddress", async () => {
    await expect(
      provider.wrapUsdc(signer, fhevm, {
        amount: 1_000_000n,
        tokenAddress: "",
        usdcAddress: VALID_USDC,
      })
    ).rejects.toThrow("Invalid tokenAddress");
  });

  it("propagates contract error", async () => {
    mockWrap.mockResolvedValue({
      hash: "0xfail",
      wait: vi.fn().mockResolvedValue({ hash: "0xfail", status: 0 }),
    });

    await expect(
      provider.wrapUsdc(signer, fhevm, {
        amount: 1_000_000n,
        tokenAddress: VALID_TOKEN,
        usdcAddress: VALID_USDC,
      })
    ).rejects.toThrow("Wrap transaction reverted");
  });
});

// ============================================================================
// unwrapCusdc Tests
// ============================================================================

describe("unwrapCusdc", () => {
  let provider: MarcFheProvider;
  let signer: Signer;
  let fhevm: FhevmInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = createProvider();
    signer = createMockSigner();
    fhevm = createMockFhevmInstance();

    mockUnwrap.mockResolvedValue({
      hash: "0xunwrap123",
      wait: vi.fn().mockResolvedValue({ hash: "0xunwrap123", blockNumber: 200, status: 1 }),
    });
  });

  it("initiates unwrap successfully", async () => {
    const result = await provider.unwrapCusdc(signer, fhevm, {
      amount: 1_000_000n,
      tokenAddress: VALID_TOKEN,
    });

    expect(result.action).toBe("unwrap_requested");
    expect(result.txHash).toBe("0xunwrap123");
    expect(result.amount).toBe("1000000");
    expect(result.note).toContain("KMS");
    expect(mockUnwrap).toHaveBeenCalledWith(
      VALID_ADDRESS_A,
      VALID_ADDRESS_A,
      "0x" + "ff".repeat(32),
      "0x" + "ee".repeat(64)
    );
  });

  it("throws on zero amount", async () => {
    await expect(
      provider.unwrapCusdc(signer, fhevm, {
        amount: 0n,
        tokenAddress: VALID_TOKEN,
      })
    ).rejects.toThrow("must be > 0");
  });

  it("throws on invalid tokenAddress", async () => {
    await expect(
      provider.unwrapCusdc(signer, fhevm, {
        amount: 1_000_000n,
        tokenAddress: "bad",
      })
    ).rejects.toThrow("Invalid tokenAddress");
  });

  it("handles FHE encryption returning no handles", async () => {
    fhevm = {
      createEncryptedInput: vi.fn().mockReturnValue({
        add64: vi.fn(),
        encrypt: vi.fn().mockResolvedValue({ handles: [], inputProof: "0x00" }),
      }),
    };

    await expect(
      provider.unwrapCusdc(signer, fhevm, {
        amount: 1_000_000n,
        tokenAddress: VALID_TOKEN,
      })
    ).rejects.toThrow("FHE encryption returned no handles");
  });
});

// ============================================================================
// confidentialTransfer Tests
// ============================================================================

describe("confidentialTransfer", () => {
  let provider: MarcFheProvider;
  let signer: Signer;
  let fhevm: FhevmInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = createProvider();
    signer = createMockSigner();
    fhevm = createMockFhevmInstance();

    mockConfidentialTransfer.mockResolvedValue({
      hash: "0xtransfer123",
      wait: vi.fn().mockResolvedValue({ hash: "0xtransfer123", blockNumber: 300, status: 1 }),
    });
  });

  it("transfers encrypted cUSDC successfully", async () => {
    const result = await provider.confidentialTransfer(signer, fhevm, {
      to: VALID_ADDRESS_B,
      amount: 500_000n,
      tokenAddress: VALID_TOKEN,
    });

    expect(result.action).toBe("confidential_transfer");
    expect(result.txHash).toBe("0xtransfer123");
    expect(result.to).toBe(VALID_ADDRESS_B);
    expect(result.encryptedHandle).toBe("0x" + "ff".repeat(32));
    expect(mockConfidentialTransfer).toHaveBeenCalledWith(
      VALID_ADDRESS_B,
      "0x" + "ff".repeat(32),
      "0x" + "ee".repeat(64)
    );
  });

  it("throws on zero amount", async () => {
    await expect(
      provider.confidentialTransfer(signer, fhevm, {
        to: VALID_ADDRESS_B,
        amount: 0n,
        tokenAddress: VALID_TOKEN,
      })
    ).rejects.toThrow("must be > 0");
  });

  it("throws on zero address recipient", async () => {
    await expect(
      provider.confidentialTransfer(signer, fhevm, {
        to: "0x0000000000000000000000000000000000000000",
        amount: 1_000_000n,
        tokenAddress: VALID_TOKEN,
      })
    ).rejects.toThrow("Invalid to");
  });

  it("throws on invalid recipient address format", async () => {
    await expect(
      provider.confidentialTransfer(signer, fhevm, {
        to: "0xinvalid",
        amount: 1_000_000n,
        tokenAddress: VALID_TOKEN,
      })
    ).rejects.toThrow("Invalid to");
  });

  it("throws on amount exceeding uint64 max", async () => {
    await expect(
      provider.confidentialTransfer(signer, fhevm, {
        to: VALID_ADDRESS_B,
        amount: BigInt("0xFFFFFFFFFFFFFFFF") + 1n,
        tokenAddress: VALID_TOKEN,
      })
    ).rejects.toThrow("exceeds uint64 max");
  });

  it("propagates contract revert", async () => {
    mockConfidentialTransfer.mockResolvedValue({
      hash: "0xfail",
      wait: vi.fn().mockResolvedValue({ hash: "0xfail", status: 0 }),
    });

    await expect(
      provider.confidentialTransfer(signer, fhevm, {
        to: VALID_ADDRESS_B,
        amount: 1_000_000n,
        tokenAddress: VALID_TOKEN,
      })
    ).rejects.toThrow("Confidential transfer reverted");
  });

  it("handles FHE encryption returning no handles", async () => {
    fhevm = {
      createEncryptedInput: vi.fn().mockReturnValue({
        add64: vi.fn(),
        encrypt: vi.fn().mockResolvedValue({ handles: [], inputProof: "0x00" }),
      }),
    };

    await expect(
      provider.confidentialTransfer(signer, fhevm, {
        to: VALID_ADDRESS_B,
        amount: 1_000_000n,
        tokenAddress: VALID_TOKEN,
      })
    ).rejects.toThrow("FHE encryption returned no handles");
  });
});

// ============================================================================
// getConfidentialBalance Tests
// ============================================================================

describe("getConfidentialBalance", () => {
  let provider: MarcFheProvider;
  let signer: Signer;
  let fhevm: FhevmInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = createProvider();
    signer = createMockSigner();
    fhevm = createMockFhevmInstance();
    mockConfidentialBalanceOf.mockResolvedValue("0x" + "aa".repeat(32));
  });

  it("returns non-zero balance handle", async () => {
    const result = await provider.getConfidentialBalance(signer, fhevm, {
      tokenAddress: VALID_TOKEN,
    });

    expect(result.action).toBe("balance");
    expect(result.address).toBe(VALID_ADDRESS_A);
    expect(result.encryptedBalanceHandle).toBe("0x" + "aa".repeat(32));
    expect(result.hasEncryptedBalance).toBe(true);
    expect(result.note).toContain("Non-zero");
  });

  it("returns zero balance handle", async () => {
    mockConfidentialBalanceOf.mockResolvedValue("0x" + "00".repeat(32));

    const result = await provider.getConfidentialBalance(signer, fhevm, {
      tokenAddress: VALID_TOKEN,
    });

    expect(result.hasEncryptedBalance).toBe(false);
    expect(result.note).toContain("Zero balance");
  });

  it("handles confidentialBalanceOf failure gracefully", async () => {
    mockConfidentialBalanceOf.mockRejectedValue(new Error("not available"));

    const result = await provider.getConfidentialBalance(signer, fhevm, {
      tokenAddress: VALID_TOKEN,
    });

    expect(result.hasEncryptedBalance).toBe(false);
    expect(result.encryptedBalanceHandle).toBe("0x" + "00".repeat(32));
  });

  it("queries custom address", async () => {
    const result = await provider.getConfidentialBalance(signer, fhevm, {
      address: VALID_ADDRESS_B,
      tokenAddress: VALID_TOKEN,
    });

    expect(result.address).toBe(VALID_ADDRESS_B);
    expect(mockConfidentialBalanceOf).toHaveBeenCalledWith(VALID_ADDRESS_B);
  });

  it("throws on invalid tokenAddress", async () => {
    await expect(
      provider.getConfidentialBalance(signer, fhevm, {
        tokenAddress: "",
      })
    ).rejects.toThrow("Invalid tokenAddress");
  });

  it("throws on invalid custom address", async () => {
    await expect(
      provider.getConfidentialBalance(signer, fhevm, {
        address: "0xinvalid",
        tokenAddress: VALID_TOKEN,
      })
    ).rejects.toThrow("Invalid address");
  });
});

// ============================================================================
// payX402Resource Tests
// ============================================================================

describe("payX402Resource", () => {
  let provider: MarcFheProvider;
  let signer: Signer;
  let fhevm: FhevmInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = createProvider();
    signer = createMockSigner();
    fhevm = createMockFhevmInstance();

    mockConfidentialTransfer.mockResolvedValue({
      hash: "0xtransfer_x402",
      wait: vi.fn().mockResolvedValue({ hash: "0xtransfer_x402", blockNumber: 400, status: 1 }),
    });
    mockRecordPayment.mockResolvedValue({
      hash: "0xverifier_x402",
      wait: vi.fn().mockResolvedValue({ hash: "0xverifier_x402", blockNumber: 401, status: 1 }),
    });
  });

  it("throws when URL is empty", async () => {
    await expect(
      provider.payX402Resource(signer, fhevm, {
        url: "",
        tokenAddress: VALID_TOKEN,
        verifierAddress: VALID_VERIFIER,
      })
    ).rejects.toThrow("URL is required");
  });

  it("throws on invalid tokenAddress", async () => {
    await expect(
      provider.payX402Resource(signer, fhevm, {
        url: "https://example.com/api",
        tokenAddress: "bad",
        verifierAddress: VALID_VERIFIER,
      })
    ).rejects.toThrow("Invalid tokenAddress");
  });

  it("throws on invalid verifierAddress", async () => {
    await expect(
      provider.payX402Resource(signer, fhevm, {
        url: "https://example.com/api",
        tokenAddress: VALID_TOKEN,
        verifierAddress: "0x0000000000000000000000000000000000000000",
      })
    ).rejects.toThrow("Invalid verifierAddress");
  });

  it("completes full x402 payment flow with mock fetch", async () => {
    // Mock global fetch for the x402 flow
    const mockFetch = vi.fn();
    // First call: 402 response with payment requirements
    mockFetch.mockResolvedValueOnce({
      status: 402,
      json: vi.fn().mockResolvedValue({
        x402Version: 1,
        accepts: [
          {
            scheme: "fhe-confidential-v1",
            network: "eip155:11155111",
            chainId: 11155111,
            price: "1000000",
            asset: "USDC",
            tokenAddress: VALID_TOKEN,
            verifierAddress: VALID_VERIFIER,
            recipientAddress: VALID_ADDRESS_B,
            maxTimeoutSeconds: 300,
          },
        ],
        resource: { url: "https://example.com/api", method: "GET" },
      }),
    });
    // Second call: 200 success after payment header
    mockFetch.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;

    try {
      const result = await provider.payX402Resource(signer, fhevm, {
        url: "https://example.com/api",
        tokenAddress: VALID_TOKEN,
        verifierAddress: VALID_VERIFIER,
      });

      expect(result.action).toBe("x402_payment");
      expect(result.transferTxHash).toBe("0xtransfer_x402");
      expect(result.verifierTxHash).toBe("0xverifier_x402");
      expect(result.nonce).toBeDefined();
      expect(result.paymentHeader).toBeDefined();
      expect(result.resourceUrl).toBe("https://example.com/api");
      expect(result.resourceResponse?.status).toBe(200);

      // Verify the second fetch was called with Payment header
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const secondCallArgs = mockFetch.mock.calls[1];
      expect(secondCallArgs[1].headers.Payment).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws when resource does not return 402", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 200 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;

    try {
      await expect(
        provider.payX402Resource(signer, fhevm, {
          url: "https://example.com/free",
          tokenAddress: VALID_TOKEN,
          verifierAddress: VALID_VERIFIER,
        })
      ).rejects.toThrow("Resource did not return 402");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws when 402 body has no matching scheme", async () => {
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
      await expect(
        provider.payX402Resource(signer, fhevm, {
          url: "https://example.com/api",
          tokenAddress: VALID_TOKEN,
          verifierAddress: VALID_VERIFIER,
        })
      ).rejects.toThrow("No matching payment requirement found");
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
            network: "eip155:11155111",
            price: "10000000", // 10 USDC
            recipientAddress: VALID_ADDRESS_B,
          },
        ],
      }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;

    try {
      await expect(
        provider.payX402Resource(signer, fhevm, {
          url: "https://example.com/api",
          tokenAddress: VALID_TOKEN,
          verifierAddress: VALID_VERIFIER,
          maxPayment: 1_000_000n, // Cap at 1 USDC
        })
      ).rejects.toThrow("No matching payment requirement found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ============================================================================
// recordPayment Tests
// ============================================================================

describe("recordPayment", () => {
  let provider: MarcFheProvider;
  let signer: Signer;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = createProvider();
    signer = createMockSigner();

    mockRecordPayment.mockResolvedValue({
      hash: "0xrecord123",
      wait: vi.fn().mockResolvedValue({ hash: "0xrecord123", blockNumber: 500, status: 1 }),
    });
  });

  it("records payment nonce on-chain", async () => {
    const result = await provider.recordPayment(signer, {
      server: VALID_ADDRESS_B,
      nonce: VALID_NONCE,
      minPrice: 1_000_000n,
      verifierAddress: VALID_VERIFIER,
    });

    expect(result.action).toBe("record_payment");
    expect(result.txHash).toBe("0xrecord123");
    expect(result.server).toBe(VALID_ADDRESS_B);
    expect(result.nonce).toBe(VALID_NONCE);
    expect(result.minPrice).toBe("1000000");
    expect(mockRecordPayment).toHaveBeenCalledWith(VALID_ADDRESS_B, VALID_NONCE, 1_000_000n);
  });

  it("throws on invalid server address", async () => {
    await expect(
      provider.recordPayment(signer, {
        server: "0x0000000000000000000000000000000000000000",
        nonce: VALID_NONCE,
        minPrice: 1_000_000n,
        verifierAddress: VALID_VERIFIER,
      })
    ).rejects.toThrow("Invalid server");
  });

  it("throws on invalid nonce format", async () => {
    await expect(
      provider.recordPayment(signer, {
        server: VALID_ADDRESS_B,
        nonce: "0xbad",
        minPrice: 1_000_000n,
        verifierAddress: VALID_VERIFIER,
      })
    ).rejects.toThrow("Invalid nonce");
  });

  it("throws on zero minPrice", async () => {
    await expect(
      provider.recordPayment(signer, {
        server: VALID_ADDRESS_B,
        nonce: VALID_NONCE,
        minPrice: 0n,
        verifierAddress: VALID_VERIFIER,
      })
    ).rejects.toThrow("must be > 0");
  });

  it("throws on invalid verifierAddress", async () => {
    await expect(
      provider.recordPayment(signer, {
        server: VALID_ADDRESS_B,
        nonce: VALID_NONCE,
        minPrice: 1_000_000n,
        verifierAddress: "",
      })
    ).rejects.toThrow("Invalid verifierAddress");
  });

  it("propagates contract revert", async () => {
    mockRecordPayment.mockResolvedValue({
      hash: "0xfail",
      wait: vi.fn().mockResolvedValue({ hash: "0xfail", status: 0 }),
    });

    await expect(
      provider.recordPayment(signer, {
        server: VALID_ADDRESS_B,
        nonce: VALID_NONCE,
        minPrice: 1_000_000n,
        verifierAddress: VALID_VERIFIER,
      })
    ).rejects.toThrow("recordPayment transaction reverted");
  });
});

// ============================================================================
// MarcProviderError Tests
// ============================================================================

describe("MarcProviderError", () => {
  it("includes message and name", () => {
    const err = new MarcProviderError("test error");
    expect(err.message).toBe("test error");
    expect(err.name).toBe("MarcProviderError");
  });

  it("includes details", () => {
    const err = new MarcProviderError("test", { txHash: "0x123" });
    expect(err.details).toEqual({ txHash: "0x123" });
  });

  it("is an instance of Error", () => {
    const err = new MarcProviderError("test");
    expect(err).toBeInstanceOf(Error);
  });
});
