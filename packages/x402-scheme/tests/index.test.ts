import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock ethers BEFORE importing module
// ---------------------------------------------------------------------------

const mockConfidentialTransfer = vi.fn();
const mockRecordPayment = vi.fn();
const mockGetAddress = vi.fn().mockResolvedValue("0x1234567890abcdef1234567890abcdef12345678");
const mockSignMessage = vi.fn().mockResolvedValue("0xsignature_mock");
const mockGetTransactionReceipt = vi.fn();

vi.mock("ethers", () => {
  const realEthers = {
    isAddress: (addr: string) => /^0x[0-9a-fA-F]{40}$/.test(addr),
    hexlify: () => "0x" + "ab".repeat(32),
    randomBytes: () => new Uint8Array(32),
    verifyMessage: (_msg: string, _sig: string) => "0x1234567890abcdef1234567890abcdef12345678",
    Interface: vi.fn().mockImplementation(() => ({
      parseLog: vi.fn().mockReturnValue({
        name: "ConfidentialTransfer",
        args: [
          "0x1234567890abcdef1234567890abcdef12345678",
          "0xaabbccddee00112233445566778899aabbccddee",
          "0x0000000000000000000000000000000000000000000000000000000000000001",
        ],
      }),
    })),
  };

  return {
    ethers: realEthers,
    Contract: vi.fn().mockImplementation((_addr: string, abi: string[]) => {
      const abiStr = JSON.stringify(abi);
      if (abiStr.includes("confidentialTransfer")) {
        return {
          confidentialTransfer: mockConfidentialTransfer,
        };
      }
      return {
        recordPayment: mockRecordPayment,
      };
    }),
    JsonRpcProvider: vi.fn().mockImplementation(() => ({
      getTransactionReceipt: mockGetTransactionReceipt,
    })),
  };
});

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

import {
  FHE_CONFIDENTIAL_SCHEME,
  FHE_SCHEME,
  SUPPORTED_CHAINS,
  createFhePaywall,
  createFheFetch,
  decodePaymentHeader,
  verifyPaymentSignature,
  canonicalPayloadMessage,
  encodePaymentHeader,
} from "../src/index.js";

import type {
  FhePaymentRequired,
  FhePaymentPayload,
  FhePaywallConfig,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Mock FhevmInstance
// ---------------------------------------------------------------------------

function createMockFhevmInstance() {
  return {
    createEncryptedInput: vi.fn().mockReturnValue({
      add64: vi.fn(),
      addAddress: vi.fn(),
      encrypt: vi.fn().mockResolvedValue({
        handles: ["0x" + "01".repeat(32)],
        inputProof: "0x" + "ff".repeat(64),
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_TOKEN = "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D";
const TEST_VERIFIER = "0x4503A7aee235aBD10e6064BBa8E14235fdF041f4";
const TEST_RECIPIENT = "0xaabbccddee00112233445566778899aabbccddee";
const TEST_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

const testConfig: FhePaywallConfig = {
  price: "1000000",
  asset: "USDC",
  tokenAddress: TEST_TOKEN,
  verifierAddress: TEST_VERIFIER,
  recipientAddress: TEST_RECIPIENT,
  rpcUrl: TEST_RPC,
  chainId: 11155111,
};

function makeChallenge(): FhePaymentRequired {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: FHE_SCHEME,
        network: "eip155:11155111",
        chainId: 11155111,
        price: "1000000",
        asset: "USDC",
        tokenAddress: TEST_TOKEN,
        verifierAddress: TEST_VERIFIER,
        recipientAddress: TEST_RECIPIENT,
        maxTimeoutSeconds: 300,
      },
    ],
    resource: { url: "https://api.example.com/premium", method: "GET" },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FHE_CONFIDENTIAL_SCHEME", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Constants ---

  it("exports correct scheme name", () => {
    expect(FHE_CONFIDENTIAL_SCHEME.name).toBe("fhe-confidential-v1");
  });

  it("exports correct version", () => {
    expect(FHE_CONFIDENTIAL_SCHEME.version).toBe("1.0.0");
  });

  it("FHE_SCHEME matches scheme name", () => {
    expect(FHE_SCHEME).toBe("fhe-confidential-v1");
  });

  // --- SUPPORTED_CHAINS ---

  it("exports supported chains", () => {
    expect(SUPPORTED_CHAINS[1]).toBe("Ethereum");
    expect(SUPPORTED_CHAINS[11155111]).toBe("Sepolia");
    expect(SUPPORTED_CHAINS[8453]).toBe("Base");
    expect(SUPPORTED_CHAINS[42161]).toBe("Arbitrum");
  });

  it("SUPPORTED_CHAINS has exactly 4 entries", () => {
    expect(Object.keys(SUPPORTED_CHAINS)).toHaveLength(4);
  });

  // --- getRequirements ---

  it("getRequirements returns correct structure", () => {
    const reqs = FHE_CONFIDENTIAL_SCHEME.getRequirements(testConfig);

    expect(reqs.scheme).toBe(FHE_SCHEME);
    expect(reqs.network).toBe("eip155:11155111");
    expect(reqs.chainId).toBe(11155111);
    expect(reqs.price).toBe("1000000");
    expect(reqs.asset).toBe("USDC");
    expect(reqs.tokenAddress).toBe(TEST_TOKEN);
    expect(reqs.verifierAddress).toBe(TEST_VERIFIER);
    expect(reqs.recipientAddress).toBe(TEST_RECIPIENT);
    expect(reqs.maxTimeoutSeconds).toBe(300);
  });

  it("getRequirements defaults chainId to Sepolia", () => {
    const { chainId: _, ...noChainConfig } = testConfig;
    const reqs = FHE_CONFIDENTIAL_SCHEME.getRequirements(noChainConfig as FhePaywallConfig);
    expect(reqs.chainId).toBe(11155111);
    expect(reqs.network).toBe("eip155:11155111");
  });

  it("getRequirements uses custom maxTimeoutSeconds", () => {
    const reqs = FHE_CONFIDENTIAL_SCHEME.getRequirements({ ...testConfig, maxTimeoutSeconds: 600 });
    expect(reqs.maxTimeoutSeconds).toBe(600);
  });

  // --- createPayment ---

  it("createPayment calls confidentialTransfer and recordPayment", async () => {
    const txHash = "0x" + "aa".repeat(32);
    const vTxHash = "0x" + "bb".repeat(32);

    mockConfidentialTransfer.mockResolvedValue({
      hash: txHash,
      wait: vi.fn().mockResolvedValue({ status: 1 }),
    });
    mockRecordPayment.mockResolvedValue({
      hash: vTxHash,
      wait: vi.fn().mockResolvedValue({ status: 1 }),
    });

    const mockSigner = {
      getAddress: mockGetAddress,
      signMessage: mockSignMessage,
    };

    const fhevmInstance = createMockFhevmInstance();
    const challenge = makeChallenge();

    const result = await FHE_CONFIDENTIAL_SCHEME.createPayment(
      challenge,
      mockSigner as any,
      fhevmInstance,
    );

    expect(result.txHash).toBe(txHash);
    expect(result.verifierTxHash).toBe(vTxHash);
    expect(result.nonce).toBeTruthy();
    expect(result.paymentHeader).toBeTruthy();
    expect(mockConfidentialTransfer).toHaveBeenCalledOnce();
    expect(mockRecordPayment).toHaveBeenCalledOnce();
  });

  it("createPayment throws if no matching FHE requirement", async () => {
    const challenge: FhePaymentRequired = {
      x402Version: 1,
      accepts: [
        {
          scheme: "other-scheme" as any,
          network: "eip155:11155111",
          chainId: 11155111,
          price: "1000000",
          asset: "USDC",
          tokenAddress: TEST_TOKEN,
          verifierAddress: TEST_VERIFIER,
          recipientAddress: TEST_RECIPIENT,
          maxTimeoutSeconds: 300,
        },
      ],
      resource: { url: "https://example.com", method: "GET" },
    };

    await expect(
      FHE_CONFIDENTIAL_SCHEME.createPayment(challenge, {} as any, createMockFhevmInstance()),
    ).rejects.toThrow("No fhe-confidential-v1 requirement in challenge");
  });

  it("createPayment throws if transfer TX fails", async () => {
    mockConfidentialTransfer.mockResolvedValue({
      hash: "0x" + "cc".repeat(32),
      wait: vi.fn().mockResolvedValue({ status: 0 }),
    });

    const mockSigner = {
      getAddress: mockGetAddress,
      signMessage: mockSignMessage,
    };

    await expect(
      FHE_CONFIDENTIAL_SCHEME.createPayment(makeChallenge(), mockSigner as any, createMockFhevmInstance()),
    ).rejects.toThrow("Payment transaction failed");
  });

  // --- verifyPayment ---

  it("verifyPayment returns invalid for bad base64", async () => {
    const result = await FHE_CONFIDENTIAL_SCHEME.verifyPayment("not-valid-base64!!!", testConfig);
    expect(result.valid).toBe(false);
  });

  it("verifyPayment returns invalid for wrong scheme", async () => {
    const badPayload = {
      scheme: "wrong-scheme",
      txHash: "0x" + "aa".repeat(32),
      verifierTxHash: "0x" + "bb".repeat(32),
      nonce: "0x" + "cc".repeat(32),
      from: "0x1234567890abcdef1234567890abcdef12345678",
      chainId: 11155111,
      signature: "0xsig",
    };
    const encoded = Buffer.from(JSON.stringify(badPayload)).toString("base64");
    const result = await FHE_CONFIDENTIAL_SCHEME.verifyPayment(encoded, testConfig);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unsupported scheme");
  });

  it("verifyPayment returns invalid for chain ID mismatch", async () => {
    const badPayload = {
      scheme: FHE_SCHEME,
      txHash: "0x" + "aa".repeat(32),
      verifierTxHash: "0x" + "bb".repeat(32),
      nonce: "0x" + "cc".repeat(32),
      from: "0x1234567890abcdef1234567890abcdef12345678",
      chainId: 1, // mainnet, but config expects Sepolia
      signature: "0xsig",
    };
    const encoded = Buffer.from(JSON.stringify(badPayload)).toString("base64");
    const result = await FHE_CONFIDENTIAL_SCHEME.verifyPayment(encoded, testConfig);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Chain ID mismatch");
  });

  it("verifyPayment returns invalid for bad nonce format", async () => {
    const badPayload = {
      scheme: FHE_SCHEME,
      txHash: "0x" + "aa".repeat(32),
      verifierTxHash: "0x" + "bb".repeat(32),
      nonce: "bad-nonce",
      from: "0x1234567890abcdef1234567890abcdef12345678",
      chainId: 11155111,
      signature: "0xsig",
    };
    const encoded = Buffer.from(JSON.stringify(badPayload)).toString("base64");
    const result = await FHE_CONFIDENTIAL_SCHEME.verifyPayment(encoded, testConfig);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid nonce format");
  });

  // --- Encoding / Decoding ---

  it("encodePaymentHeader and decodePaymentHeader roundtrip", () => {
    const payload: FhePaymentPayload = {
      scheme: FHE_SCHEME,
      txHash: "0x" + "aa".repeat(32),
      verifierTxHash: "0x" + "bb".repeat(32),
      nonce: "0x" + "cc".repeat(32),
      from: "0x1234567890abcdef1234567890abcdef12345678",
      chainId: 11155111,
      signature: "0xsig123",
    };

    const encoded = encodePaymentHeader(payload);
    expect(typeof encoded).toBe("string");

    const decoded = decodePaymentHeader(encoded);
    expect(decoded.scheme).toBe(payload.scheme);
    expect(decoded.txHash).toBe(payload.txHash);
    expect(decoded.verifierTxHash).toBe(payload.verifierTxHash);
    expect(decoded.nonce).toBe(payload.nonce);
    expect(decoded.from).toBe(payload.from);
    expect(decoded.chainId).toBe(payload.chainId);
    expect(decoded.signature).toBe(payload.signature);
  });

  it("decodePaymentHeader throws on invalid JSON", () => {
    const bad = Buffer.from("not json").toString("base64");
    expect(() => decodePaymentHeader(bad)).toThrow();
  });

  it("decodePaymentHeader throws on missing fields", () => {
    const incomplete = Buffer.from(JSON.stringify({ scheme: "x" })).toString("base64");
    expect(() => decodePaymentHeader(incomplete)).toThrow("missing required fields");
  });

  // --- canonicalPayloadMessage ---

  it("canonicalPayloadMessage sorts keys and excludes signature", () => {
    const data = { z: 1, a: 2, signature: "ignore", m: 3 };
    const msg = canonicalPayloadMessage(data);
    const parsed = JSON.parse(msg);
    expect(Object.keys(parsed)).toEqual(["a", "m", "z"]);
    expect(parsed).not.toHaveProperty("signature");
  });

  // --- createFhePaywall ---

  it("createFhePaywall throws on invalid token address", () => {
    expect(() => createFhePaywall({ ...testConfig, tokenAddress: "bad" })).toThrow("Invalid token address");
  });

  it("createFhePaywall throws on invalid verifier address", () => {
    expect(() => createFhePaywall({ ...testConfig, verifierAddress: "bad" })).toThrow("Invalid verifier address");
  });

  it("createFhePaywall throws on invalid recipient address", () => {
    expect(() => createFhePaywall({ ...testConfig, recipientAddress: "bad" })).toThrow("Invalid recipient address");
  });

  it("createFhePaywall middleware returns 402 when no Payment header", async () => {
    const middleware = createFhePaywall(testConfig);

    const req = {
      method: "GET",
      protocol: "https",
      originalUrl: "/api/premium",
      headers: {} as Record<string, string | undefined>,
      get: (key: string) => (key === "host" ? "api.example.com" : undefined),
    };

    let statusCode = 0;
    let jsonBody: any = null;
    const res = {
      status: vi.fn().mockImplementation((code: number) => {
        statusCode = code;
        return res;
      }),
      json: vi.fn().mockImplementation((body: unknown) => {
        jsonBody = body;
      }),
      setHeader: vi.fn(),
    };
    const next = vi.fn();

    await middleware(req, res, next);

    expect(statusCode).toBe(402);
    expect(jsonBody.x402Version).toBe(1);
    expect(jsonBody.accepts).toHaveLength(1);
    expect(jsonBody.accepts[0].scheme).toBe(FHE_SCHEME);
    expect(jsonBody.accepts[0].price).toBe("1000000");
    expect(next).not.toHaveBeenCalled();
  });

  it("createFhePaywall rejects oversized Payment header", async () => {
    const middleware = createFhePaywall(testConfig);

    const req = {
      method: "GET",
      headers: { payment: "x".repeat(200_000) } as Record<string, string | undefined>,
    };

    let statusCode = 0;
    let jsonBody: any = null;
    const res = {
      status: vi.fn().mockImplementation((code: number) => {
        statusCode = code;
        return res;
      }),
      json: vi.fn().mockImplementation((body: unknown) => {
        jsonBody = body;
      }),
      setHeader: vi.fn(),
    };
    const next = vi.fn();

    await middleware(req, res, next);

    expect(statusCode).toBe(400);
    expect(jsonBody.error).toBe("Payment header too large");
  });
});

describe("createFheFetch", () => {
  it("returns a function", () => {
    const mockSigner = { getAddress: mockGetAddress, signMessage: mockSignMessage };
    const fetchFn = createFheFetch(mockSigner as any, createMockFhevmInstance());
    expect(typeof fetchFn).toBe("function");
  });
});
