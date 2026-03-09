import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fheFetch, createFheFetch, fheFetchWithCallback } from "../src/fheFetch.js";
import { FHE_SCHEME } from "../src/types.js";
import type { FheFetchOptions, FhePaymentRequired } from "../src/types.js";

// ============================================================================
// Mock global fetch
// ============================================================================

const originalFetch = globalThis.fetch;

function create402Body(): FhePaymentRequired {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: FHE_SCHEME,
        network: "eip155:11155111",
        chainId: 11155111,
        price: "1000000",
        asset: "USDC",
        poolAddress: "0x1234567890123456789012345678901234567890",
        recipientAddress: "0xaabbccddee112233445566778899aabbccddeeff",
        maxTimeoutSeconds: 300,
      },
    ],
    resource: { url: "https://api.example.com/data", method: "GET" },
  };
}

function createMockFetchOptions(): FheFetchOptions {
  return {
    poolAddress: "0x1234567890123456789012345678901234567890",
    rpcUrl: "http://localhost:8545",
    signer: {
      getAddress: vi.fn().mockResolvedValue("0xAlice"),
      provider: {
        getTransactionReceipt: vi.fn().mockResolvedValue({ status: 1, blockNumber: 100 }),
      },
    } as any,
    fhevmInstance: {
      createEncryptedInput: vi.fn().mockReturnValue({
        add64: vi.fn(),
        encrypt: vi.fn().mockResolvedValue({
          handles: ["0xhandle"],
          inputProof: "0xproof",
        }),
      }),
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("fheFetch", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should pass through non-402 responses", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("OK", { status: 200 })
    );

    const response = await fheFetch("https://api.example.com/data", createMockFetchOptions());
    expect(response.status).toBe(200);
  });

  it("should return 402 in dryRun mode", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(create402Body()), { status: 402 })
    );

    const options = { ...createMockFetchOptions(), dryRun: true };
    const response = await fheFetch("https://api.example.com/data", options);
    expect(response.status).toBe(402);
  });

  it("should return original 402 when no matching scheme", async () => {
    const body = create402Body();
    body.accepts[0].scheme = "other-scheme" as any;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { status: 402 })
    );

    const response = await fheFetch("https://api.example.com/data", createMockFetchOptions());
    expect(response.status).toBe(402);
  });

  it("should return original 402 when network filtered", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(create402Body()), { status: 402 })
    );

    const options = {
      ...createMockFetchOptions(),
      allowedNetworks: ["eip155:1"],
    };
    const response = await fheFetch("https://api.example.com/data", options);
    expect(response.status).toBe(402);
  });

  it("should return original 402 when price exceeds maxPayment", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(create402Body()), { status: 402 })
    );

    const options = {
      ...createMockFetchOptions(),
      maxPayment: 500_000n,
    };
    const response = await fheFetch("https://api.example.com/data", options);
    expect(response.status).toBe(402);
  });

  it("should handle 404 response without attempting payment", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Not Found", { status: 404 })
    );

    const response = await fheFetch("https://api.example.com/data", createMockFetchOptions());
    expect(response.status).toBe(404);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // No retry
  });

  it("should handle 500 response without attempting payment", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Server Error", { status: 500 })
    );

    const response = await fheFetch("https://api.example.com/data", createMockFetchOptions());
    expect(response.status).toBe(500);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("should handle invalid 402 body gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("not json", { status: 402 })
    );

    const response = await fheFetch("https://api.example.com/data", createMockFetchOptions());
    // Should return original 402 since parsing fails
    expect(response.status).toBe(402);
  });

  it("should handle malformed 402 JSON gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ bad: "data" }), { status: 402 })
    );

    const response = await fheFetch("https://api.example.com/data", createMockFetchOptions());
    expect(response.status).toBe(402);
  });

  it("should pass through non-402 with timeout option", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("OK", { status: 200 })
    );

    const options = { ...createMockFetchOptions(), timeoutMs: 5000 };
    const response = await fheFetch("https://api.example.com/data", options);
    expect(response.status).toBe(200);
  });

  it("should pass through non-402 with retry options", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("OK", { status: 200 })
    );

    const options = { ...createMockFetchOptions(), maxRetries: 3, retryDelayMs: 100 };
    const response = await fheFetch("https://api.example.com/data", options);
    expect(response.status).toBe(200);
    // Should only call fetch once for non-402
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("should pass memo option through", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("OK", { status: 200 })
    );

    const options = { ...createMockFetchOptions(), memo: "0x" + "ab".repeat(32) };
    const response = await fheFetch("https://api.example.com/data", options);
    expect(response.status).toBe(200);
  });
});

describe("createFheFetch", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should create a bound fetch function", () => {
    const boundFetch = createFheFetch(createMockFetchOptions());
    expect(typeof boundFetch).toBe("function");
  });

  it("should pass through non-402 responses", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("OK", { status: 200 })
    );

    const boundFetch = createFheFetch(createMockFetchOptions());
    const response = await boundFetch("https://api.example.com/data");
    expect(response.status).toBe(200);
  });
});

describe("fheFetchWithCallback", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should pass through non-402 without calling callback", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("OK", { status: 200 })
    );

    const onPayment = vi.fn();
    const response = await fheFetchWithCallback(
      "https://api.example.com/data",
      createMockFetchOptions(),
      onPayment
    );

    expect(response.status).toBe(200);
    expect(onPayment).not.toHaveBeenCalled();
  });

  it("should return 402 in dryRun without calling callback", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(create402Body()), { status: 402 })
    );

    const onPayment = vi.fn();
    const options = { ...createMockFetchOptions(), dryRun: true };
    const response = await fheFetchWithCallback(
      "https://api.example.com/data",
      options,
      onPayment
    );

    expect(response.status).toBe(402);
    expect(onPayment).not.toHaveBeenCalled();
  });

  it("should return original 402 when no scheme match, without callback", async () => {
    const body = create402Body();
    body.accepts[0].scheme = "wrong" as any;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { status: 402 })
    );

    const onPayment = vi.fn();
    const response = await fheFetchWithCallback(
      "https://api.example.com/data",
      createMockFetchOptions(),
      onPayment
    );

    expect(response.status).toBe(402);
    expect(onPayment).not.toHaveBeenCalled();
  });
});
