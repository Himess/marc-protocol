import { describe, it, expect } from "vitest";
import {
  FheX402Error,
  PaymentError,
  EncryptionError,
  VerificationError,
  TimeoutError,
  NetworkError,
  FheErrorCode,
} from "../src/errors.js";

describe("FheX402Error", () => {
  it("should create error with code and message", () => {
    const err = new FheX402Error(FheErrorCode.PAYMENT_FAILED, "Payment failed");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FheX402Error);
    expect(err.name).toBe("FheX402Error");
    expect(err.code).toBe(FheErrorCode.PAYMENT_FAILED);
    expect(err.message).toBe("Payment failed");
    expect(err.details).toBeUndefined();
  });

  it("should include optional details", () => {
    const err = new FheX402Error(FheErrorCode.TIMEOUT, "Timed out", {
      url: "https://example.com",
      timeoutMs: 5000,
    });
    expect(err.details).toEqual({ url: "https://example.com", timeoutMs: 5000 });
  });
});

describe("PaymentError", () => {
  it("should have PAYMENT_FAILED code", () => {
    const err = new PaymentError("TX reverted");
    expect(err.name).toBe("PaymentError");
    expect(err.code).toBe(FheErrorCode.PAYMENT_FAILED);
    expect(err).toBeInstanceOf(FheX402Error);
    expect(err).toBeInstanceOf(Error);
  });

  it("should include tx details", () => {
    const err = new PaymentError("TX reverted", { txHash: "0xabc", amount: "1000000" });
    expect(err.details?.txHash).toBe("0xabc");
  });
});

describe("EncryptionError", () => {
  it("should have ENCRYPTION_FAILED code", () => {
    const err = new EncryptionError("FHE init failed");
    expect(err.name).toBe("EncryptionError");
    expect(err.code).toBe(FheErrorCode.ENCRYPTION_FAILED);
  });
});

describe("VerificationError", () => {
  it("should have VERIFICATION_FAILED code", () => {
    const err = new VerificationError("Event not found");
    expect(err.name).toBe("VerificationError");
    expect(err.code).toBe(FheErrorCode.VERIFICATION_FAILED);
  });
});

describe("TimeoutError", () => {
  it("should have TIMEOUT code", () => {
    const err = new TimeoutError("Request timed out", { timeoutMs: 30000 });
    expect(err.name).toBe("TimeoutError");
    expect(err.code).toBe(FheErrorCode.TIMEOUT);
    expect(err.details?.timeoutMs).toBe(30000);
  });
});

describe("NetworkError", () => {
  it("should have NETWORK_ERROR code", () => {
    const err = new NetworkError("Connection refused", { retries: 3 });
    expect(err.name).toBe("NetworkError");
    expect(err.code).toBe(FheErrorCode.NETWORK_ERROR);
    expect(err.details?.retries).toBe(3);
  });
});

describe("FheErrorCode enum", () => {
  it("should have all expected codes", () => {
    expect(FheErrorCode.PAYMENT_FAILED).toBe("PAYMENT_FAILED");
    expect(FheErrorCode.ENCRYPTION_FAILED).toBe("ENCRYPTION_FAILED");
    expect(FheErrorCode.INVALID_RESPONSE).toBe("INVALID_RESPONSE");
    expect(FheErrorCode.NO_MATCHING_REQUIREMENT).toBe("NO_MATCHING_REQUIREMENT");
    expect(FheErrorCode.NONCE_REPLAY).toBe("NONCE_REPLAY");
    expect(FheErrorCode.VERIFICATION_FAILED).toBe("VERIFICATION_FAILED");
    expect(FheErrorCode.TIMEOUT).toBe("TIMEOUT");
    expect(FheErrorCode.NETWORK_ERROR).toBe("NETWORK_ERROR");
    expect(FheErrorCode.INSUFFICIENT_BALANCE).toBe("INSUFFICIENT_BALANCE");
    expect(FheErrorCode.CONTRACT_PAUSED).toBe("CONTRACT_PAUSED");
  });
});
