import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock express
// ---------------------------------------------------------------------------

const mockUse = vi.fn();
const mockGet = vi.fn();
const mockPost = vi.fn();
const mockJson = vi.fn().mockReturnThis();

const mockApp = {
  use: mockUse,
  get: mockGet,
  post: mockPost,
  listen: vi.fn(),
};

vi.mock("express", () => {
  const expressFn = () => mockApp;
  expressFn.json = () => mockJson;
  expressFn.default = expressFn;
  return { default: expressFn };
});

// Mock ethers
const mockGetTransactionReceipt = vi.fn();
const mockParseLog = vi.fn();

vi.mock("ethers", () => ({
  ethers: {
    JsonRpcProvider: vi.fn().mockImplementation(() => ({
      getTransactionReceipt: mockGetTransactionReceipt,
    })),
    Interface: vi.fn().mockImplementation(() => ({
      parseLog: mockParseLog,
    })),
  },
}));

import { createFacilitatorServer } from "../src/facilitator.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createFacilitatorServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an express app", async () => {
    const app = await createFacilitatorServer({
      poolAddress: "0x1234567890abcdef1234567890abcdef12345678",
      rpcUrl: "https://sepolia.infura.io",
    });

    expect(app).toBeDefined();
    expect(mockUse).toHaveBeenCalled();
    expect(mockGet).toHaveBeenCalled();
    expect(mockPost).toHaveBeenCalled();
  });

  it("registers /info, /verify, /health endpoints", async () => {
    await createFacilitatorServer({
      poolAddress: "0x1234567890abcdef1234567890abcdef12345678",
      rpcUrl: "https://sepolia.infura.io",
    });

    const getRoutes = mockGet.mock.calls.map((c: any[]) => c[0]);
    const postRoutes = mockPost.mock.calls.map((c: any[]) => c[0]);

    expect(getRoutes).toContain("/info");
    expect(getRoutes).toContain("/health");
    expect(postRoutes).toContain("/verify");
  });

  it("adds API key middleware when apiKey is set", async () => {
    await createFacilitatorServer({
      poolAddress: "0x1234567890abcdef1234567890abcdef12345678",
      rpcUrl: "https://sepolia.infura.io",
      apiKey: "test-api-key-123",
    });

    // First use() call is json parser, second is API key middleware
    expect(mockUse.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("/info endpoint", () => {
  let infoHandler: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    await createFacilitatorServer({
      poolAddress: "0x1234567890abcdef1234567890abcdef12345678",
      rpcUrl: "https://sepolia.infura.io",
    });

    const infoCall = mockGet.mock.calls.find((c: any[]) => c[0] === "/info");
    infoHandler = infoCall?.[1];
  });

  it("returns correct scheme and features", () => {
    const res = { json: vi.fn() };
    infoHandler({}, res);

    const data = res.json.mock.calls[0][0];
    expect(data.schemes).toContain("fhe-confidential-v1");
    expect(data.features).toContain("fhe-encrypted-amounts");
    expect(data.features).toContain("silent-failure-privacy");
    expect(data.tokens).toContain("USDC");
    expect(data.protocolFee).toBe("0.1%");
  });

  it("uses custom name and version", async () => {
    vi.clearAllMocks();
    await createFacilitatorServer({
      poolAddress: "0x1234567890abcdef1234567890abcdef12345678",
      rpcUrl: "https://sepolia.infura.io",
      name: "Custom Facilitator",
      version: "2.0.0",
    });

    const call = mockGet.mock.calls.find((c: any[]) => c[0] === "/info");
    const handler = call?.[1];
    const res = { json: vi.fn() };
    handler({}, res);

    const data = res.json.mock.calls[0][0];
    expect(data.name).toBe("Custom Facilitator");
    expect(data.version).toBe("2.0.0");
  });

  it("uses default network eip155:11155111", () => {
    const res = { json: vi.fn() };
    infoHandler({}, res);

    const data = res.json.mock.calls[0][0];
    expect(data.networks).toContain("eip155:11155111");
  });
});

describe("/health endpoint", () => {
  it("returns ok status", async () => {
    vi.clearAllMocks();
    await createFacilitatorServer({
      poolAddress: "0x1234567890abcdef1234567890abcdef12345678",
      rpcUrl: "https://sepolia.infura.io",
    });

    const healthCall = mockGet.mock.calls.find((c: any[]) => c[0] === "/health");
    const handler = healthCall?.[1];
    const res = { json: vi.fn() };
    handler({}, res);

    const data = res.json.mock.calls[0][0];
    expect(data.status).toBe("ok");
    expect(data.timestamp).toBeDefined();
  });
});

describe("/verify endpoint", () => {
  let verifyHandler: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    await createFacilitatorServer({
      poolAddress: "0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73",
      rpcUrl: "https://sepolia.infura.io",
    });

    const verifyCall = mockPost.mock.calls.find((c: any[]) => c[0] === "/verify");
    verifyHandler = verifyCall?.[1];
  });

  it("rejects unsupported scheme", async () => {
    const req = { body: { scheme: "wrong-scheme", payload: { txHash: "0xabc" } } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await verifyHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toContain("Unsupported scheme");
  });

  it("rejects missing payload", async () => {
    const req = { body: { scheme: "fhe-confidential-v1" } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await verifyHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toContain("Missing payload");
  });

  it("rejects failed transaction", async () => {
    mockGetTransactionReceipt.mockResolvedValue({ status: 0 });

    const req = {
      body: {
        scheme: "fhe-confidential-v1",
        payload: { txHash: "0xabc123" },
      },
    };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await verifyHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toContain("failed or not found");
  });

  it("rejects when PaymentExecuted event not found", async () => {
    mockGetTransactionReceipt.mockResolvedValue({
      status: 1,
      hash: "0xabc123",
      blockNumber: 100,
      logs: [],
    });

    const req = {
      body: {
        scheme: "fhe-confidential-v1",
        payload: { txHash: "0xabc123" },
      },
    };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await verifyHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toContain("not found");
  });

  it("verifies valid PaymentExecuted event", async () => {
    const poolAddr = "0xff87ec6cb07d8aa26abc81037e353a28c7752d73";
    mockGetTransactionReceipt.mockResolvedValue({
      status: 1,
      hash: "0xabc123",
      blockNumber: 100,
      logs: [{ address: poolAddr, topics: ["0x"], data: "0x" }],
    });
    mockParseLog.mockReturnValue({
      name: "PaymentExecuted",
      args: ["0xAlice", "0xBob", 1000000n, "0xnonce1"],
    });

    const req = {
      body: {
        scheme: "fhe-confidential-v1",
        payload: { txHash: "0xabc123" },
      },
    };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await verifyHandler(req, res);

    const data = res.json.mock.calls[0][0];
    expect(data.valid).toBe(true);
    expect(data.txHash).toBe("0xabc123");
    expect(data.blockNumber).toBe(100);
  });
});

describe("API key authentication", () => {
  it("rejects request with wrong API key", async () => {
    vi.clearAllMocks();
    await createFacilitatorServer({
      poolAddress: "0x1234567890abcdef1234567890abcdef12345678",
      rpcUrl: "https://sepolia.infura.io",
      apiKey: "correct-api-key",
    });

    // API key middleware is the second use() call
    const authMiddleware = mockUse.mock.calls[1]?.[0];
    if (!authMiddleware) return;

    const req = {
      path: "/verify",
      headers: { "x-fhe-x402-api-key": "wrong-key" },
    };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("allows /health without API key", async () => {
    vi.clearAllMocks();
    await createFacilitatorServer({
      poolAddress: "0x1234567890abcdef1234567890abcdef12345678",
      rpcUrl: "https://sepolia.infura.io",
      apiKey: "correct-api-key",
    });

    const authMiddleware = mockUse.mock.calls[1]?.[0];
    if (!authMiddleware) return;

    const req = { path: "/health", headers: {} };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});
