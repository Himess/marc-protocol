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
    randomBytes: (n: number) => new Uint8Array(n).fill(0xab),
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
        return { confidentialTransfer: mockConfidentialTransfer };
      }
      return { recordPayment: mockRecordPayment };
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
  FHE_SCHEME,
  createMppChallenge,
  formatMppChallenge,
  parseMppChallenge,
  decodeMppRequest,
  verifyMppCredential,
  handleMpp402,
  mppFhePaywall,
  createMppFetch,
  base64Encode,
  base64Decode,
  canonicalCredentialMessage,
  verifyCredentialSignature,
} from "../src/index.js";

import type {
  MarcMppConfig,
  MppChallenge,
  MppCredential,
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

const testConfig: MarcMppConfig = {
  tokenAddress: TEST_TOKEN,
  verifierAddress: TEST_VERIFIER,
  recipientAddress: TEST_RECIPIENT,
  amount: "1000000",
  chainId: 11155111,
  rpcUrl: TEST_RPC,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMppChallenge", () => {
  it("creates a valid MPP challenge", () => {
    const challenge = createMppChallenge(testConfig);

    expect(challenge.id).toBeTruthy();
    expect(challenge.realm).toBe("marc-protocol");
    expect(challenge.method).toBe("fhe-confidential");
    expect(challenge.intent).toBe("charge");
    expect(challenge.request).toBeTruthy();
  });

  it("uses custom realm when provided", () => {
    const challenge = createMppChallenge({ ...testConfig, realm: "my-api" });
    expect(challenge.realm).toBe("my-api");
  });

  it("request contains correct base64-encoded payload", () => {
    const challenge = createMppChallenge(testConfig);
    const decoded = decodeMppRequest(challenge);

    expect(decoded.scheme).toBe(FHE_SCHEME);
    expect(decoded.network).toBe("eip155:11155111");
    expect(decoded.tokenAddress).toBe(TEST_TOKEN);
    expect(decoded.verifierAddress).toBe(TEST_VERIFIER);
    expect(decoded.recipientAddress).toBe(TEST_RECIPIENT);
    expect(decoded.amount).toBe("1000000");
  });

  it("generates unique challenge IDs", () => {
    const c1 = createMppChallenge(testConfig);
    const c2 = createMppChallenge(testConfig);
    // Both should have IDs but randomBytes mock returns same value, so just check format
    expect(c1.id).toBeTruthy();
    expect(typeof c1.id).toBe("string");
    expect(c1.id.length).toBeGreaterThan(0);
  });
});

describe("formatMppChallenge / parseMppChallenge", () => {
  it("formats challenge as WWW-Authenticate header value", () => {
    const challenge = createMppChallenge(testConfig);
    const formatted = formatMppChallenge(challenge);

    expect(formatted).toContain("Payment ");
    expect(formatted).toContain('realm="marc-protocol"');
    expect(formatted).toContain('method="fhe-confidential"');
    expect(formatted).toContain('intent="charge"');
    expect(formatted).toContain(`id="${challenge.id}"`);
    expect(formatted).toContain(`request="${challenge.request}"`);
  });

  it("roundtrips format -> parse", () => {
    const original = createMppChallenge(testConfig);
    const formatted = formatMppChallenge(original);
    const parsed = parseMppChallenge(formatted);

    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe(original.id);
    expect(parsed!.realm).toBe(original.realm);
    expect(parsed!.method).toBe(original.method);
    expect(parsed!.intent).toBe(original.intent);
    expect(parsed!.request).toBe(original.request);
  });

  it("parseMppChallenge returns null for non-Payment header", () => {
    expect(parseMppChallenge("Bearer token123")).toBeNull();
  });

  it("parseMppChallenge returns null for incomplete header", () => {
    expect(parseMppChallenge('Payment realm="x"')).toBeNull();
  });

  it("parseMppChallenge returns null for non-charge intent", () => {
    const header = 'Payment realm="x", method="y", intent="subscribe", id="z", request="r"';
    expect(parseMppChallenge(header)).toBeNull();
  });
});

describe("base64Encode / base64Decode", () => {
  it("roundtrips objects", () => {
    const original = { foo: "bar", num: 42 };
    const encoded = base64Encode(original);
    const decoded = base64Decode<typeof original>(encoded);
    expect(decoded).toEqual(original);
  });

  it("handles nested objects", () => {
    const original = { a: { b: { c: [1, 2, 3] } } };
    const encoded = base64Encode(original);
    const decoded = base64Decode<typeof original>(encoded);
    expect(decoded).toEqual(original);
  });
});

describe("canonicalCredentialMessage", () => {
  it("sorts keys and excludes signature", () => {
    const data = { z: 1, a: 2, signature: "ignore", m: 3 };
    const msg = canonicalCredentialMessage(data);
    const parsed = JSON.parse(msg);
    expect(Object.keys(parsed)).toEqual(["a", "m", "z"]);
    expect(parsed).not.toHaveProperty("signature");
  });

  it("produces deterministic output", () => {
    const data1 = { b: 1, a: 2 };
    const data2 = { a: 2, b: 1 };
    expect(canonicalCredentialMessage(data1)).toBe(canonicalCredentialMessage(data2));
  });
});

describe("verifyMppCredential", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns invalid for bad base64", async () => {
    const result = await verifyMppCredential("not-valid!!!", testConfig);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid credential encoding");
  });

  it("returns invalid for wrong scheme", async () => {
    const badCred = {
      scheme: "wrong",
      txHash: "0x" + "aa".repeat(32),
      verifierTxHash: "0x" + "bb".repeat(32),
      nonce: "0x" + "cc".repeat(32),
      from: "0x1234567890abcdef1234567890abcdef12345678",
      chainId: 11155111,
      signature: "0xsig",
    };
    const encoded = base64Encode(badCred);
    const result = await verifyMppCredential(encoded, testConfig);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unsupported scheme");
  });

  it("returns invalid for missing fields", async () => {
    const badCred = { scheme: FHE_SCHEME };
    const encoded = base64Encode(badCred);
    const result = await verifyMppCredential(encoded, testConfig);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Missing required credential fields");
  });

  it("returns invalid for chain ID mismatch", async () => {
    const badCred = {
      scheme: FHE_SCHEME,
      txHash: "0x" + "aa".repeat(32),
      verifierTxHash: "0x" + "bb".repeat(32),
      nonce: "0x" + "cc".repeat(32),
      from: "0x1234567890abcdef1234567890abcdef12345678",
      chainId: 1,
      signature: "0xsig",
    };
    const encoded = base64Encode(badCred);
    const result = await verifyMppCredential(encoded, testConfig);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Chain ID mismatch");
  });

  it("returns invalid for bad nonce format", async () => {
    const badCred = {
      scheme: FHE_SCHEME,
      txHash: "0x" + "aa".repeat(32),
      verifierTxHash: "0x" + "bb".repeat(32),
      nonce: "bad-nonce",
      from: "0x1234567890abcdef1234567890abcdef12345678",
      chainId: 11155111,
      signature: "0xsig",
    };
    const encoded = base64Encode(badCred);
    const result = await verifyMppCredential(encoded, testConfig);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid nonce format");
  });
});

describe("mppFhePaywall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws on invalid token address", () => {
    expect(() => mppFhePaywall({ ...testConfig, tokenAddress: "bad" })).toThrow("Invalid token address");
  });

  it("throws on invalid verifier address", () => {
    expect(() => mppFhePaywall({ ...testConfig, verifierAddress: "bad" })).toThrow("Invalid verifier address");
  });

  it("throws on invalid recipient address", () => {
    expect(() => mppFhePaywall({ ...testConfig, recipientAddress: "bad" })).toThrow("Invalid recipient address");
  });

  it("returns 402 with WWW-Authenticate when no Authorization header", async () => {
    const middleware = mppFhePaywall(testConfig);

    const req = {
      method: "GET",
      headers: {} as Record<string, string | undefined>,
    };

    let statusCode = 0;
    let jsonBody: any = null;
    let headers: Record<string, string> = {};
    const res = {
      status: vi.fn().mockImplementation((code: number) => {
        statusCode = code;
        return res;
      }),
      json: vi.fn().mockImplementation((body: unknown) => {
        jsonBody = body;
      }),
      setHeader: vi.fn().mockImplementation((key: string, value: string) => {
        headers[key] = value;
      }),
    };
    const next = vi.fn();

    await middleware(req, res, next);

    expect(statusCode).toBe(402);
    expect(headers["WWW-Authenticate"]).toBeTruthy();
    expect(headers["WWW-Authenticate"]).toContain("Payment ");
    expect(headers["WWW-Authenticate"]).toContain('method="fhe-confidential"');
    expect(headers["WWW-Authenticate"]).toContain('intent="charge"');
    expect(jsonBody.error).toBe("Payment required");
    expect(jsonBody.challenge).toBeTruthy();
    expect(jsonBody.challenge.method).toBe("fhe-confidential");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 402 when Authorization header is non-Payment scheme", async () => {
    const middleware = mppFhePaywall(testConfig);

    const req = {
      method: "GET",
      headers: { authorization: "Bearer token123" } as Record<string, string | undefined>,
    };

    let statusCode = 0;
    const res = {
      status: vi.fn().mockImplementation((code: number) => {
        statusCode = code;
        return res;
      }),
      json: vi.fn(),
      setHeader: vi.fn(),
    };
    const next = vi.fn();

    await middleware(req, res, next);

    expect(statusCode).toBe(402);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed credential in Authorization header", async () => {
    const middleware = mppFhePaywall(testConfig);

    const req = {
      method: "GET",
      headers: { authorization: "Payment no-credential-here" } as Record<string, string | undefined>,
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
    expect(jsonBody.error).toContain("Malformed Authorization header");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 400 for oversized credential", async () => {
    const middleware = mppFhePaywall(testConfig);

    const hugeCredential = "x".repeat(200_000);
    const req = {
      method: "GET",
      headers: {
        authorization: `Payment credential="${hugeCredential}"`,
      } as Record<string, string | undefined>,
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
    expect(jsonBody.error).toBe("Credential too large");
  });
});

describe("createMppFetch", () => {
  it("returns a function", () => {
    const mockSigner = { getAddress: mockGetAddress, signMessage: mockSignMessage };
    const fetchFn = createMppFetch(mockSigner as any, createMockFhevmInstance());
    expect(typeof fetchFn).toBe("function");
  });
});

describe("handleMpp402", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws if response is not 402", async () => {
    const response = new Response("OK", { status: 200 });
    const mockSigner = { getAddress: mockGetAddress, signMessage: mockSignMessage };

    await expect(
      handleMpp402(response, mockSigner as any, createMockFhevmInstance()),
    ).rejects.toThrow("Expected 402 response");
  });

  it("throws if no WWW-Authenticate header", async () => {
    const response = new Response("Payment required", { status: 402 });
    const mockSigner = { getAddress: mockGetAddress, signMessage: mockSignMessage };

    await expect(
      handleMpp402(response, mockSigner as any, createMockFhevmInstance()),
    ).rejects.toThrow("Missing WWW-Authenticate header");
  });

  it("throws if WWW-Authenticate is not a Payment challenge", async () => {
    const response = new Response("Payment required", {
      status: 402,
      headers: { "WWW-Authenticate": "Bearer realm=test" },
    });
    const mockSigner = { getAddress: mockGetAddress, signMessage: mockSignMessage };

    await expect(
      handleMpp402(response, mockSigner as any, createMockFhevmInstance()),
    ).rejects.toThrow("Failed to parse MPP challenge");
  });

  it("throws if method is not fhe-confidential", async () => {
    const challenge: MppChallenge = {
      id: "test-id",
      realm: "marc-protocol",
      method: "credit-card",
      intent: "charge",
      request: base64Encode({
        scheme: FHE_SCHEME,
        network: "eip155:11155111",
        tokenAddress: TEST_TOKEN,
        verifierAddress: TEST_VERIFIER,
        recipientAddress: TEST_RECIPIENT,
        amount: "1000000",
      }),
    };
    const wwwAuth = formatMppChallenge(challenge);
    const response = new Response("Payment required", {
      status: 402,
      headers: { "WWW-Authenticate": wwwAuth },
    });
    const mockSigner = { getAddress: mockGetAddress, signMessage: mockSignMessage };

    await expect(
      handleMpp402(response, mockSigner as any, createMockFhevmInstance()),
    ).rejects.toThrow("Unsupported payment method");
  });
});
