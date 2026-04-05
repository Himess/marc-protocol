import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock ethers BEFORE importing module
// ---------------------------------------------------------------------------

const mockConfidentialTransfer = vi.fn();
const mockRecordPayment = vi.fn();
const mockGetAddress = vi.fn().mockResolvedValue("0x1234567890abcdef1234567890abcdef12345678");
const mockSignTypedData = vi.fn().mockResolvedValue("0xsignature_mock_eip712");
const mockSignMessage = vi.fn().mockResolvedValue("0xsignature_mock");
const mockGetTransactionReceipt = vi.fn();

vi.mock("ethers", () => {
  const realEthers = {
    isAddress: (addr: string) => /^0x[0-9a-fA-F]{40}$/.test(addr),
    getAddress: (addr: string) => addr, // passthrough for tests
    hexlify: () => "0x" + "ab".repeat(32),
    randomBytes: (n: number) => new Uint8Array(n).fill(0xab),
    verifyTypedData: (_domain: unknown, _types: unknown, _value: unknown, _sig: string) =>
      "0x1234567890abcdef1234567890abcdef12345678",
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

// Mock crypto for HMAC and Hash in tests
vi.mock("crypto", () => {
  return {
    createHmac: (_alg: string, secret: string) => {
      let data = "";
      return {
        update: (input: string) => {
          data = input;
        },
        digest: (_enc: string) => {
          // Simple deterministic "hash" for testing that incorporates the secret
          let hash = 0;
          const combined = secret + ":" + data;
          for (let i = 0; i < combined.length; i++) {
            hash = ((hash << 5) - hash + combined.charCodeAt(i)) | 0;
          }
          return Math.abs(hash).toString(16).padStart(32, "0").slice(0, 32);
        },
      };
    },
    createHash: (_alg: string) => {
      let data = "";
      const self = {
        update: (input: string) => {
          data = input;
          return self;
        },
        digest: (_enc: string) => {
          // Simple deterministic hash for testing
          let hash = 0;
          for (let i = 0; i < data.length; i++) {
            hash = ((hash << 5) - hash + data.charCodeAt(i)) | 0;
          }
          return Math.abs(hash).toString(16).padStart(64, "0");
        },
      };
      return self;
    },
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
  base64UrlEncode,
  base64UrlDecode,
  canonicalCredentialMessage,
  verifyCredentialSignature,
  canonicalJson,
  createChallengeId,
  isChallengeExpired,
  createMppReceipt,
  validateAmount,
  validateAddress,
  checksumAddress,
  problemPaymentRequired,
  problemBadRequest,
  problemUnauthorized,
  problemChallengeExpired,
  problemTooManyRequests,
  problemChallengeReplay,
  problemUnknownChallenge,
  InMemoryChallengeStore,
  RateLimiter,
  InMemoryNonceStore,
} from "../src/index.js";

import type {
  MarcMppConfig,
  MppChallenge,
  MppCredential,
  MppReceipt,
  ProblemDetails,
  MppNonceStore,
  MppPaywallConfig,
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

/**
 * Helper: build a valid MppCredential for tests.
 */
function buildTestCredential(
  overrides?: Partial<MppCredential["payload"]>,
  challengeOverrides?: Partial<MppCredential["challenge"]>
): MppCredential {
  return {
    challenge: {
      id: "test-challenge-id",
      realm: "marc-protocol",
      method: "fhe-confidential",
      intent: "charge",
      ...challengeOverrides,
    },
    source: "did:ethr:0x1234567890abcdef1234567890abcdef12345678",
    payload: {
      scheme: FHE_SCHEME,
      txHash: "0x" + "aa".repeat(32),
      verifierTxHash: "0x" + "bb".repeat(32),
      nonce: "0x" + "cc".repeat(32),
      from: "0x1234567890abcdef1234567890abcdef12345678",
      chainId: 11155111,
      signature: "0xsignature_mock_eip712",
      ...overrides,
    },
  };
}

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

  it("request contains correct base64url-encoded payload", () => {
    const challenge = createMppChallenge(testConfig);
    const decoded = decodeMppRequest(challenge);

    expect(decoded.scheme).toBe(FHE_SCHEME);
    expect(decoded.network).toBe("eip155:11155111");
    expect(decoded.tokenAddress).toBe(TEST_TOKEN);
    expect(decoded.verifierAddress).toBe(TEST_VERIFIER);
    expect(decoded.recipientAddress).toBe(TEST_RECIPIENT);
    expect(decoded.amount).toBe("1000000");
  });

  it("generates HMAC-bound challenge IDs", () => {
    const c1 = createMppChallenge(testConfig);
    expect(c1.id).toBeTruthy();
    expect(typeof c1.id).toBe("string");
    expect(c1.id.length).toBe(32);
  });

  it("includes expires field (RFC 3339 timestamp)", () => {
    const challenge = createMppChallenge(testConfig);
    expect(challenge.expires).toBeTruthy();
    // Should be a valid ISO date
    const parsed = new Date(challenge.expires!);
    expect(parsed.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it("uses custom challengeTtlMs", () => {
    const challenge = createMppChallenge({ ...testConfig, challengeTtlMs: 60_000 });
    const expires = new Date(challenge.expires!).getTime();
    const now = Date.now();
    // Should be ~1 minute from now (allow 5s tolerance)
    expect(expires).toBeGreaterThan(now + 55_000);
    expect(expires).toBeLessThan(now + 65_000);
  });

  it("includes description when provided", () => {
    const challenge = createMppChallenge({ ...testConfig, description: "Premium API access" });
    expect(challenge.description).toBe("Premium API access");
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

  it("includes expires in formatted output", () => {
    const challenge = createMppChallenge(testConfig);
    const formatted = formatMppChallenge(challenge);
    expect(formatted).toContain(`expires="${challenge.expires}"`);
  });

  it("includes optional fields in formatted output", () => {
    const challenge: MppChallenge = {
      id: "test-id",
      realm: "marc-protocol",
      method: "fhe-confidential",
      intent: "charge",
      request: "dGVzdA",
      expires: "2030-01-01T00:00:00.000Z",
      digest: "sha-256=abc123",
      description: "Test payment",
      opaque: "server-data",
    };
    const formatted = formatMppChallenge(challenge);
    expect(formatted).toContain('digest="sha-256=abc123"');
    expect(formatted).toContain('description="Test payment"');
    expect(formatted).toContain('opaque="server-data"');
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
    expect(parsed!.expires).toBe(original.expires);
  });

  it("roundtrips optional fields", () => {
    const original: MppChallenge = {
      id: "test-id",
      realm: "marc-protocol",
      method: "fhe-confidential",
      intent: "charge",
      request: "dGVzdA",
      digest: "sha-256=abc",
      description: "My payment",
      opaque: "opaque-data",
    };
    const formatted = formatMppChallenge(original);
    const parsed = parseMppChallenge(formatted);

    expect(parsed).not.toBeNull();
    expect(parsed!.digest).toBe("sha-256=abc");
    expect(parsed!.description).toBe("My payment");
    expect(parsed!.opaque).toBe("opaque-data");
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

describe("base64UrlEncode / base64UrlDecode", () => {
  it("roundtrips objects", () => {
    const original = { foo: "bar", num: 42 };
    const encoded = base64UrlEncode(original);
    const decoded = base64UrlDecode<typeof original>(encoded);
    expect(decoded).toEqual(original);
  });

  it("handles nested objects", () => {
    const original = { a: { b: { c: [1, 2, 3] } } };
    const encoded = base64UrlEncode(original);
    const decoded = base64UrlDecode<typeof original>(encoded);
    expect(decoded).toEqual(original);
  });

  it("produces URL-safe output (no +, /, or = padding)", () => {
    // Use data that would produce +, /, = in regular base64
    const data = { test: "hello world!!!", binary: ">>??<<" };
    const encoded = base64UrlEncode(data);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
  });

  it("differs from regular base64", () => {
    const data = { test: "data with special chars: >><<" };
    const urlEncoded = base64UrlEncode(data);
    const regularEncoded = base64Encode(data);
    // They encode the same data but may differ in character set
    const urlDecoded = base64UrlDecode(urlEncoded);
    const regularDecoded = base64Decode(regularEncoded);
    expect(urlDecoded).toEqual(regularDecoded);
  });
});

describe("legacy base64Encode / base64Decode", () => {
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

describe("canonicalJson (RFC 8785)", () => {
  it("sorts keys alphabetically", () => {
    const result = canonicalJson({ z: 1, a: 2, m: 3 });
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  it("handles nested objects with sorted keys", () => {
    const result = canonicalJson({ b: { d: 1, c: 2 }, a: 3 });
    expect(result).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  it("handles arrays (order preserved)", () => {
    const result = canonicalJson([3, 1, 2]);
    expect(result).toBe("[3,1,2]");
  });

  it("handles primitives", () => {
    expect(canonicalJson("hello")).toBe('"hello"');
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(null)).toBe("null");
  });

  it("is deterministic regardless of key insertion order", () => {
    const obj1 = { c: 3, a: 1, b: 2 };
    const obj2 = { a: 1, b: 2, c: 3 };
    expect(canonicalJson(obj1)).toBe(canonicalJson(obj2));
  });

  it("handles empty objects and arrays", () => {
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson([])).toBe("[]");
  });
});

describe("canonicalCredentialMessage (legacy)", () => {
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

describe("createChallengeId (HMAC binding)", () => {
  it("returns a 32-character hex string", () => {
    const id = createChallengeId({ realm: "test", method: "fhe" }, "secret");
    expect(id).toHaveLength(32);
    expect(/^[0-9a-f]{32}$/.test(id)).toBe(true);
  });

  it("is deterministic for same inputs", () => {
    const id1 = createChallengeId({ a: "1", b: "2" }, "secret");
    const id2 = createChallengeId({ a: "1", b: "2" }, "secret");
    expect(id1).toBe(id2);
  });

  it("differs for different inputs", () => {
    const id1 = createChallengeId({ a: "1" }, "secret");
    const id2 = createChallengeId({ a: "2" }, "secret");
    expect(id1).not.toBe(id2);
  });

  it("differs for different secrets", () => {
    const id1 = createChallengeId({ a: "1" }, "secret1");
    const id2 = createChallengeId({ a: "1" }, "secret2");
    expect(id1).not.toBe(id2);
  });

  it("uses canonical JSON (key order independent)", () => {
    const id1 = createChallengeId({ b: "2", a: "1" }, "secret");
    const id2 = createChallengeId({ a: "1", b: "2" }, "secret");
    expect(id1).toBe(id2);
  });
});

describe("isChallengeExpired", () => {
  it("returns false if no expires field", () => {
    const challenge: MppChallenge = {
      id: "test",
      realm: "marc-protocol",
      method: "fhe-confidential",
      intent: "charge",
      request: "test",
    };
    expect(isChallengeExpired(challenge)).toBe(false);
  });

  it("returns false for future expires", () => {
    const challenge: MppChallenge = {
      id: "test",
      realm: "marc-protocol",
      method: "fhe-confidential",
      intent: "charge",
      request: "test",
      expires: new Date(Date.now() + 300_000).toISOString(),
    };
    expect(isChallengeExpired(challenge)).toBe(false);
  });

  it("returns true for past expires", () => {
    const challenge: MppChallenge = {
      id: "test",
      realm: "marc-protocol",
      method: "fhe-confidential",
      intent: "charge",
      request: "test",
      expires: new Date(Date.now() - 1000).toISOString(),
    };
    expect(isChallengeExpired(challenge)).toBe(true);
  });

  it("returns false for invalid date string", () => {
    const challenge: MppChallenge = {
      id: "test",
      realm: "marc-protocol",
      method: "fhe-confidential",
      intent: "charge",
      request: "test",
      expires: "not-a-date",
    };
    expect(isChallengeExpired(challenge)).toBe(false);
  });
});

describe("validateAmount", () => {
  it("accepts valid amounts", () => {
    expect(validateAmount("0")).toBe(true);
    expect(validateAmount("1000000")).toBe(true);
    expect(validateAmount("999999999999")).toBe(true);
  });

  it("rejects non-numeric strings", () => {
    expect(validateAmount("abc")).toBe(false);
    expect(validateAmount("1.5")).toBe(false);
    expect(validateAmount("-1")).toBe(false);
    expect(validateAmount("")).toBe(false);
  });

  it("rejects amounts exceeding max", () => {
    expect(validateAmount("1000000000001")).toBe(false);
  });
});

describe("validateAddress", () => {
  it("accepts valid addresses", () => {
    expect(validateAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe(true);
  });

  it("rejects invalid addresses", () => {
    expect(validateAddress("bad")).toBe(false);
    expect(validateAddress("0x123")).toBe(false);
    expect(validateAddress("")).toBe(false);
  });
});

describe("RFC 7807 Problem Details", () => {
  it("creates payment-required problem", () => {
    const p = problemPaymentRequired();
    expect(p.status).toBe(402);
    expect(p.title).toBe("Payment Required");
    expect(p.type).toContain("payment-required");
    expect(p.detail).toBeTruthy();
  });

  it("creates payment-required with custom detail", () => {
    const p = problemPaymentRequired("Custom message");
    expect(p.detail).toBe("Custom message");
  });

  it("creates bad-request problem", () => {
    const p = problemBadRequest("Invalid nonce");
    expect(p.status).toBe(400);
    expect(p.title).toBe("Bad Request");
    expect(p.detail).toBe("Invalid nonce");
  });

  it("creates unauthorized problem", () => {
    const p = problemUnauthorized("Signature mismatch");
    expect(p.status).toBe(401);
    expect(p.title).toBe("Unauthorized");
    expect(p.detail).toBe("Signature mismatch");
  });

  it("creates challenge-expired problem", () => {
    const p = problemChallengeExpired();
    expect(p.status).toBe(402);
    expect(p.title).toBe("Challenge Expired");
  });
});

describe("createMppReceipt", () => {
  it("creates a valid receipt", () => {
    const receipt = createMppReceipt("0xabc123", "0x1234", "1000000");
    expect(receipt.status).toBe("success");
    expect(receipt.method).toBe(FHE_SCHEME);
    expect(receipt.reference).toBe("0xabc123");
    expect(receipt.from).toBe("0x1234");
    expect(receipt.amount).toBe("1000000");
    expect(receipt.timestamp).toBeTruthy();
    // Timestamp should be valid ISO
    expect(new Date(receipt.timestamp).getTime()).toBeGreaterThan(0);
  });

  it("works without optional fields", () => {
    const receipt = createMppReceipt("0xdef456");
    expect(receipt.reference).toBe("0xdef456");
    expect(receipt.from).toBeUndefined();
    expect(receipt.amount).toBeUndefined();
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
    const cred = buildTestCredential({ scheme: "wrong" as any });
    const encoded = base64UrlEncode(cred);
    const result = await verifyMppCredential(encoded, testConfig);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unsupported scheme");
  });

  it("returns invalid for missing fields", async () => {
    const cred = {
      challenge: { id: "x", realm: "x", method: "x", intent: "x" },
      payload: { scheme: FHE_SCHEME },
    };
    const encoded = base64UrlEncode(cred);
    const result = await verifyMppCredential(encoded, testConfig);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Missing required credential fields");
  });

  it("returns invalid for chain ID mismatch", async () => {
    const cred = buildTestCredential({ chainId: 1 });
    const encoded = base64UrlEncode(cred);
    const result = await verifyMppCredential(encoded, testConfig);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Chain ID mismatch");
  });

  it("returns invalid for bad nonce format", async () => {
    const cred = buildTestCredential({ nonce: "bad-nonce" });
    const encoded = base64UrlEncode(cred);
    const result = await verifyMppCredential(encoded, testConfig);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid nonce format");
  });

  it("returns invalid for challenge ID mismatch", async () => {
    const cred = buildTestCredential({}, { id: "wrong-id" });
    const encoded = base64UrlEncode(cred);
    const challenge: MppChallenge = {
      id: "correct-id",
      realm: "marc-protocol",
      method: "fhe-confidential",
      intent: "charge",
      request: "test",
      expires: new Date(Date.now() + 300_000).toISOString(),
    };
    const result = await verifyMppCredential(encoded, testConfig, challenge);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Challenge ID mismatch");
  });

  it("returns invalid for expired challenge", async () => {
    const cred = buildTestCredential({}, { id: "expired-challenge" });
    const encoded = base64UrlEncode(cred);
    const challenge: MppChallenge = {
      id: "expired-challenge",
      realm: "marc-protocol",
      method: "fhe-confidential",
      intent: "charge",
      request: "test",
      expires: new Date(Date.now() - 60_000).toISOString(),
    };
    const result = await verifyMppCredential(encoded, testConfig, challenge);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Challenge has expired");
  });

  it("returns invalid for challenge realm mismatch", async () => {
    const cred = buildTestCredential({}, { id: "ch-id", realm: "wrong-realm" });
    const encoded = base64UrlEncode(cred);
    const challenge: MppChallenge = {
      id: "ch-id",
      realm: "marc-protocol",
      method: "fhe-confidential",
      intent: "charge",
      request: "test",
      expires: new Date(Date.now() + 300_000).toISOString(),
    };
    const result = await verifyMppCredential(encoded, testConfig, challenge);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Challenge realm mismatch");
  });
});

describe("EIP-712 Signature", () => {
  it("verifyCredentialSignature returns true for matching address", () => {
    const cred = buildTestCredential();
    expect(verifyCredentialSignature(cred)).toBe(true);
  });

  it("verifyCredentialSignature returns false for empty signature", () => {
    const cred = buildTestCredential({ signature: "" });
    expect(verifyCredentialSignature(cred)).toBe(false);
  });

  it("verifyCredentialSignature returns false for address mismatch", () => {
    const cred = buildTestCredential({
      from: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });
    // Mock verifyTypedData returns 0x1234...5678 which won't match 0xdead...beef
    expect(verifyCredentialSignature(cred)).toBe(false);
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

  it("throws on invalid amount", () => {
    expect(() => mppFhePaywall({ ...testConfig, amount: "abc" })).toThrow("Invalid amount");
  });

  it("returns 402 with WWW-Authenticate and RFC 7807 body when no Authorization header", async () => {
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
    expect(headers["WWW-Authenticate"]).toContain("expires=");
    // RFC 7807 format
    expect(jsonBody.type).toContain("payment-required");
    expect(jsonBody.title).toBe("Payment Required");
    expect(jsonBody.status).toBe(402);
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

  it("returns 400 for empty credential in Authorization header", async () => {
    const middleware = mppFhePaywall(testConfig);

    const req = {
      method: "GET",
      headers: { authorization: "Payment " } as Record<string, string | undefined>,
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
    expect(jsonBody.detail).toContain("Missing credential");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 400 for oversized credential", async () => {
    const middleware = mppFhePaywall(testConfig);

    const hugeCredential = "x".repeat(200_000);
    const req = {
      method: "GET",
      headers: {
        authorization: `Payment ${hugeCredential}`,
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
    expect(jsonBody.detail).toBe("Credential too large");
  });

  it("returns 400 for invalid credential encoding", async () => {
    const middleware = mppFhePaywall(testConfig);

    const req = {
      method: "GET",
      headers: {
        authorization: "Payment !!!invalid-base64!!!",
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
    expect(jsonBody.detail).toContain("Invalid credential encoding");
  });

  it("returns 400 for invalid nonce format in credential", async () => {
    const middleware = mppFhePaywall(testConfig);

    const cred = buildTestCredential({ nonce: "bad-nonce" });
    const encoded = base64UrlEncode(cred);
    const req = {
      method: "GET",
      headers: {
        authorization: `Payment ${encoded}`,
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
    expect(jsonBody.detail).toContain("Invalid nonce format");
  });
});

describe("createMppFetch", () => {
  it("returns a function", () => {
    const mockSigner = {
      getAddress: mockGetAddress,
      signTypedData: mockSignTypedData,
      signMessage: mockSignMessage,
    };
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
    const mockSigner = {
      getAddress: mockGetAddress,
      signTypedData: mockSignTypedData,
      signMessage: mockSignMessage,
    };

    await expect(handleMpp402(response, mockSigner as any, createMockFhevmInstance())).rejects.toThrow(
      "Expected 402 response"
    );
  });

  it("throws if no WWW-Authenticate header", async () => {
    const response = new Response("Payment required", { status: 402 });
    const mockSigner = {
      getAddress: mockGetAddress,
      signTypedData: mockSignTypedData,
      signMessage: mockSignMessage,
    };

    await expect(handleMpp402(response, mockSigner as any, createMockFhevmInstance())).rejects.toThrow(
      "Missing WWW-Authenticate header"
    );
  });

  it("throws if WWW-Authenticate is not a Payment challenge", async () => {
    const response = new Response("Payment required", {
      status: 402,
      headers: { "WWW-Authenticate": "Bearer realm=test" },
    });
    const mockSigner = {
      getAddress: mockGetAddress,
      signTypedData: mockSignTypedData,
      signMessage: mockSignMessage,
    };

    await expect(handleMpp402(response, mockSigner as any, createMockFhevmInstance())).rejects.toThrow(
      "Failed to parse MPP challenge"
    );
  });

  it("throws if method is not fhe-confidential", async () => {
    const challenge: MppChallenge = {
      id: "test-id",
      realm: "marc-protocol",
      method: "credit-card",
      intent: "charge",
      request: base64UrlEncode({
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
    const mockSigner = {
      getAddress: mockGetAddress,
      signTypedData: mockSignTypedData,
      signMessage: mockSignMessage,
    };

    await expect(handleMpp402(response, mockSigner as any, createMockFhevmInstance())).rejects.toThrow(
      "Unsupported payment method"
    );
  });

  it("throws if challenge has expired", async () => {
    const challenge: MppChallenge = {
      id: "test-id",
      realm: "marc-protocol",
      method: "fhe-confidential",
      intent: "charge",
      request: base64UrlEncode({
        scheme: FHE_SCHEME,
        network: "eip155:11155111",
        tokenAddress: TEST_TOKEN,
        verifierAddress: TEST_VERIFIER,
        recipientAddress: TEST_RECIPIENT,
        amount: "1000000",
      }),
      expires: new Date(Date.now() - 60_000).toISOString(),
    };
    const wwwAuth = formatMppChallenge(challenge);
    const response = new Response("Payment required", {
      status: 402,
      headers: { "WWW-Authenticate": wwwAuth },
    });
    const mockSigner = {
      getAddress: mockGetAddress,
      signTypedData: mockSignTypedData,
      signMessage: mockSignMessage,
    };

    await expect(handleMpp402(response, mockSigner as any, createMockFhevmInstance())).rejects.toThrow(
      "Challenge has expired"
    );
  });
});

describe("decodeMppRequest", () => {
  it("decodes base64url-encoded request", () => {
    const payload = {
      scheme: FHE_SCHEME,
      network: "eip155:11155111",
      tokenAddress: TEST_TOKEN,
      verifierAddress: TEST_VERIFIER,
      recipientAddress: TEST_RECIPIENT,
      amount: "1000000",
    };
    const challenge: MppChallenge = {
      id: "test",
      realm: "marc-protocol",
      method: "fhe-confidential",
      intent: "charge",
      request: base64UrlEncode(payload),
    };
    const decoded = decodeMppRequest(challenge);
    expect(decoded).toEqual(payload);
  });

  it("falls back to legacy base64 decoding", () => {
    const payload = {
      scheme: FHE_SCHEME,
      network: "eip155:11155111",
      tokenAddress: TEST_TOKEN,
      verifierAddress: TEST_VERIFIER,
      recipientAddress: TEST_RECIPIENT,
      amount: "1000000",
    };
    const challenge: MppChallenge = {
      id: "test",
      realm: "marc-protocol",
      method: "fhe-confidential",
      intent: "charge",
      request: base64Encode(payload),
    };
    const decoded = decodeMppRequest(challenge);
    expect(decoded).toEqual(payload);
  });
});

describe("MppCredential structure (challenge binding)", () => {
  it("has challenge echo fields", () => {
    const cred = buildTestCredential();
    expect(cred.challenge).toBeDefined();
    expect(cred.challenge.id).toBe("test-challenge-id");
    expect(cred.challenge.realm).toBe("marc-protocol");
    expect(cred.challenge.method).toBe("fhe-confidential");
    expect(cred.challenge.intent).toBe("charge");
  });

  it("has optional DID source", () => {
    const cred = buildTestCredential();
    expect(cred.source).toMatch(/^did:ethr:0x/);
  });

  it("has nested payload structure", () => {
    const cred = buildTestCredential();
    expect(cred.payload).toBeDefined();
    expect(cred.payload.scheme).toBe(FHE_SCHEME);
    expect(cred.payload.txHash).toBeTruthy();
    expect(cred.payload.nonce).toBeTruthy();
    expect(cred.payload.from).toBeTruthy();
    expect(cred.payload.signature).toBeTruthy();
  });

  it("roundtrips through base64url encoding", () => {
    const cred = buildTestCredential();
    const encoded = base64UrlEncode(cred);
    const decoded = base64UrlDecode<MppCredential>(encoded);
    expect(decoded.challenge.id).toBe(cred.challenge.id);
    expect(decoded.payload.txHash).toBe(cred.payload.txHash);
    expect(decoded.source).toBe(cred.source);
  });
});

// ===========================================================================
// Feature 2: Digest Parameter
// ===========================================================================

describe("Digest Parameter (Feature 2)", () => {
  it("creates challenge with digest when requestBody is provided", () => {
    const body = { action: "purchase", item: "premium-api-key" };
    const challenge = createMppChallenge(testConfig, body);
    expect(challenge.digest).toBeTruthy();
    expect(typeof challenge.digest).toBe("string");
  });

  it("creates challenge without digest when no requestBody", () => {
    const challenge = createMppChallenge(testConfig);
    expect(challenge.digest).toBeUndefined();
  });

  it("produces consistent digest for same body", () => {
    const body = { foo: "bar" };
    const c1 = createMppChallenge(testConfig, body);
    const c2 = createMppChallenge(testConfig, body);
    expect(c1.digest).toBe(c2.digest);
  });

  it("produces different digest for different body", () => {
    const c1 = createMppChallenge(testConfig, { a: 1 });
    const c2 = createMppChallenge(testConfig, { a: 2 });
    expect(c1.digest).not.toBe(c2.digest);
  });

  it("formats digest in WWW-Authenticate header", () => {
    const challenge = createMppChallenge(testConfig, { test: true });
    const header = formatMppChallenge(challenge);
    expect(header).toContain(`digest="${challenge.digest}"`);
  });

  it("parses digest from WWW-Authenticate header", () => {
    const challenge = createMppChallenge(testConfig, { test: true });
    const header = formatMppChallenge(challenge);
    const parsed = parseMppChallenge(header);
    expect(parsed).not.toBeNull();
    expect(parsed!.digest).toBe(challenge.digest);
  });
});

// ===========================================================================
// Feature 3: Challenge Replay Detection
// ===========================================================================

describe("InMemoryChallengeStore (Feature 3)", () => {
  it("issues and validates a challenge", () => {
    const store = new InMemoryChallengeStore();
    store.issue("challenge-1");
    expect(store.has("challenge-1")).toBe(true);
    expect(store.isValid("challenge-1")).toBe(true);
  });

  it("returns false for unknown challenges", () => {
    const store = new InMemoryChallengeStore();
    expect(store.has("unknown")).toBe(false);
    expect(store.isValid("unknown")).toBe(false);
  });

  it("consumes a challenge and prevents reuse", () => {
    const store = new InMemoryChallengeStore();
    store.issue("challenge-2");
    expect(store.consume("challenge-2")).toBe(true);
    // Already consumed
    expect(store.consume("challenge-2")).toBe(false);
    // Still has it, but not valid
    expect(store.has("challenge-2")).toBe(true);
    expect(store.isValid("challenge-2")).toBe(false);
  });

  it("returns false when consuming unknown challenge", () => {
    const store = new InMemoryChallengeStore();
    expect(store.consume("nonexistent")).toBe(false);
  });

  it("cleans up old entries", async () => {
    const store = new InMemoryChallengeStore();
    store.issue("old-challenge");
    // Wait a tick so the entry is at least 1ms old, then clean with maxAge=0
    await new Promise((r) => setTimeout(r, 5));
    store.cleanup(0);
    expect(store.has("old-challenge")).toBe(false);
  });

  it("middleware returns 400 for unknown challenge ID", async () => {
    const middleware = mppFhePaywall(testConfig);

    const cred = buildTestCredential({ nonce: "0x" + "dd".repeat(32) }, { id: "unknown-challenge-id" });
    const encoded = base64UrlEncode(cred);

    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      setHeader: vi.fn(),
    };

    await middleware({ method: "GET", headers: { authorization: `Payment ${encoded}` } }, mockRes, vi.fn());

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ title: "Unknown Challenge" }));
  });
});

// ===========================================================================
// Feature 4: Nonce Store with Redis Option
// ===========================================================================

describe("MppNonceStore interface (Feature 4)", () => {
  it("middleware uses external nonce store when provided", async () => {
    const externalStore: MppNonceStore = {
      has: vi.fn().mockResolvedValue(true), // pretend nonce is already used
      add: vi.fn().mockResolvedValue(undefined),
    };

    const paywallConfig: MppPaywallConfig = {
      ...testConfig,
      externalNonceStore: externalStore,
    };

    const middleware = mppFhePaywall(paywallConfig);

    // First, get a challenge so we have a valid challenge ID
    const challengeRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      setHeader: vi.fn(),
    };
    await middleware({ method: "GET", headers: {} }, challengeRes, vi.fn());

    // Extract challenge ID from the WWW-Authenticate header
    const wwwAuth = challengeRes.setHeader.mock.calls.find((c: string[]) => c[0] === "WWW-Authenticate")?.[1] as string;
    const challengeIdMatch = wwwAuth?.match(/id="([^"]*)"/);
    const challengeId = challengeIdMatch?.[1] ?? "test";

    const cred = buildTestCredential({ nonce: "0x" + "dd".repeat(32) }, { id: challengeId });
    const encoded = base64UrlEncode(cred);

    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      setHeader: vi.fn(),
    };

    await middleware({ method: "GET", headers: { authorization: `Payment ${encoded}` } }, mockRes, vi.fn());

    expect(externalStore.has).toHaveBeenCalledWith("0x" + "dd".repeat(32));
    // Since has returned true, should reject as duplicate
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ detail: "Nonce already used" }));
  });

  it("external nonce store add is called for fresh nonces", async () => {
    const externalStore: MppNonceStore = {
      has: vi.fn().mockResolvedValue(false), // nonce not used yet
      add: vi.fn().mockResolvedValue(undefined),
    };

    const paywallConfig: MppPaywallConfig = {
      ...testConfig,
      externalNonceStore: externalStore,
    };

    const middleware = mppFhePaywall(paywallConfig);

    // Get a challenge first
    const challengeRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      setHeader: vi.fn(),
    };
    await middleware({ method: "GET", headers: {} }, challengeRes, vi.fn());

    const wwwAuth = challengeRes.setHeader.mock.calls.find((c: string[]) => c[0] === "WWW-Authenticate")?.[1] as string;
    const challengeIdMatch = wwwAuth?.match(/id="([^"]*)"/);
    const challengeId = challengeIdMatch?.[1] ?? "test";

    const cred = buildTestCredential({ nonce: "0x" + "ee".repeat(32) }, { id: challengeId });
    const encoded = base64UrlEncode(cred);

    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      setHeader: vi.fn(),
    };

    await middleware({ method: "GET", headers: { authorization: `Payment ${encoded}` } }, mockRes, vi.fn());

    expect(externalStore.has).toHaveBeenCalledWith("0x" + "ee".repeat(32));
    expect(externalStore.add).toHaveBeenCalledWith("0x" + "ee".repeat(32));
  });
});

// ===========================================================================
// Feature 5: Rate Limiting
// ===========================================================================

describe("RateLimiter (Feature 5)", () => {
  it("allows requests within limit", () => {
    const limiter = new RateLimiter();
    expect(limiter.check("192.168.1.1", 5)).toBe(true);
    expect(limiter.check("192.168.1.1", 5)).toBe(true);
    expect(limiter.check("192.168.1.1", 5)).toBe(true);
  });

  it("blocks requests over limit", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 3; i++) {
      limiter.check("192.168.1.2", 3);
    }
    expect(limiter.check("192.168.1.2", 3)).toBe(false);
  });

  it("tracks different IPs separately", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 3; i++) {
      limiter.check("ip-a", 3);
    }
    expect(limiter.check("ip-a", 3)).toBe(false);
    expect(limiter.check("ip-b", 3)).toBe(true); // different IP still allowed
  });

  it("cleanup removes expired entries", () => {
    const limiter = new RateLimiter();
    limiter.check("ip-c", 10);
    limiter.cleanup();
    // After cleanup, entry should still be there since it hasn't expired
    // (it won't cause an error though)
    expect(limiter.check("ip-c", 10)).toBe(true);
  });

  it("middleware returns 429 when rate limit exceeded", async () => {
    const paywallConfig: MppPaywallConfig = {
      ...testConfig,
      rateLimitPerMinute: 2,
    };

    const middleware = mppFhePaywall(paywallConfig);

    const makeReq = () => ({
      method: "GET",
      headers: {} as Record<string, string | undefined>,
      ip: "10.0.0.1",
    });

    // First two requests should succeed (return 402 for no auth)
    for (let i = 0; i < 2; i++) {
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        setHeader: vi.fn(),
      };
      await middleware(makeReq(), res, vi.fn());
      expect(res.status).toHaveBeenCalledWith(402);
    }

    // Third request should be rate limited
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      setHeader: vi.fn(),
    };
    await middleware(makeReq(), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ title: "Too Many Requests" }));
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "60");
  });
});

// ===========================================================================
// Feature 6: MppPaywallConfig
// ===========================================================================

describe("MppPaywallConfig (Feature 6)", () => {
  it("accepts MppPaywallConfig with all new options", () => {
    const externalStore: MppNonceStore = {
      has: vi.fn().mockResolvedValue(false),
      add: vi.fn().mockResolvedValue(undefined),
    };

    const config: MppPaywallConfig = {
      tokenAddress: TEST_TOKEN,
      verifierAddress: TEST_VERIFIER,
      recipientAddress: TEST_RECIPIENT,
      amount: "1000000",
      chainId: 11155111,
      rpcUrl: TEST_RPC,
      hmacSecret: "my-secret",
      challengeTtlMs: 600_000,
      rateLimitPerMinute: 100,
      externalNonceStore: externalStore,
    };

    // Should not throw
    const middleware = mppFhePaywall(config);
    expect(typeof middleware).toBe("function");
  });

  it("works with plain MarcMppConfig (backward compat)", () => {
    const middleware = mppFhePaywall(testConfig);
    expect(typeof middleware).toBe("function");
  });
});

// ===========================================================================
// Problem detail helpers
// ===========================================================================

describe("New problem detail helpers", () => {
  it("problemTooManyRequests returns 429", () => {
    const problem = problemTooManyRequests();
    expect(problem.status).toBe(429);
    expect(problem.title).toBe("Too Many Requests");
  });

  it("problemChallengeReplay returns 400", () => {
    const problem = problemChallengeReplay();
    expect(problem.status).toBe(400);
    expect(problem.title).toBe("Challenge Already Used");
  });

  it("problemUnknownChallenge returns 400", () => {
    const problem = problemUnknownChallenge();
    expect(problem.status).toBe(400);
    expect(problem.title).toBe("Unknown Challenge");
  });
});
