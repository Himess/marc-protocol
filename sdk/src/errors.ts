// SPDX-License-Identifier: BUSL-1.1

/**
 * FHE x402 SDK Error Classes
 *
 * Structured error hierarchy for better error handling in agent integrations.
 */

export enum FheErrorCode {
  PAYMENT_FAILED = "PAYMENT_FAILED",
  ENCRYPTION_FAILED = "ENCRYPTION_FAILED",
  INVALID_RESPONSE = "INVALID_RESPONSE",
  NO_MATCHING_REQUIREMENT = "NO_MATCHING_REQUIREMENT",
  NONCE_REPLAY = "NONCE_REPLAY",
  VERIFICATION_FAILED = "VERIFICATION_FAILED",
  TIMEOUT = "TIMEOUT",
  NETWORK_ERROR = "NETWORK_ERROR",
  INSUFFICIENT_BALANCE = "INSUFFICIENT_BALANCE",
  CONTRACT_PAUSED = "CONTRACT_PAUSED",
}

export class FheX402Error extends Error {
  readonly code: FheErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: FheErrorCode, message: string, details?: Record<string, unknown>, options?: ErrorOptions) {
    super(message, options);
    this.name = "FheX402Error";
    this.code = code;
    this.details = details;
  }
}

export class PaymentError extends FheX402Error {
  constructor(message: string, details?: Record<string, unknown>) {
    super(FheErrorCode.PAYMENT_FAILED, message, details);
    this.name = "PaymentError";
  }
}

export class EncryptionError extends FheX402Error {
  constructor(message: string, details?: Record<string, unknown>) {
    super(FheErrorCode.ENCRYPTION_FAILED, message, details);
    this.name = "EncryptionError";
  }
}

export class VerificationError extends FheX402Error {
  constructor(message: string, details?: Record<string, unknown>) {
    super(FheErrorCode.VERIFICATION_FAILED, message, details);
    this.name = "VerificationError";
  }
}

export class TimeoutError extends FheX402Error {
  constructor(message: string, details?: Record<string, unknown>) {
    super(FheErrorCode.TIMEOUT, message, details);
    this.name = "TimeoutError";
  }
}

export class NetworkError extends FheX402Error {
  constructor(message: string, details?: Record<string, unknown>, options?: ErrorOptions) {
    super(FheErrorCode.NETWORK_ERROR, message, details, options);
    this.name = "NetworkError";
  }
}
