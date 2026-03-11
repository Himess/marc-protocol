// SPDX-License-Identifier: BUSL-1.1
import { FhePaymentHandler } from "./fhePaymentHandler.js";
import type { FhePaymentResult } from "./fhePaymentHandler.js";
import type { FheFetchOptions } from "./types.js";
import { TimeoutError, NetworkError } from "./errors.js";

/**
 * Creates an x402 FHE-aware fetch function bound to a signer.
 *
 * Automatically handles 402 responses by encrypting payment and retrying.
 */
export function createFheFetch(
  defaultOptions: FheFetchOptions
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  return (url: string | URL, init?: RequestInit) =>
    fheFetch(url, { ...defaultOptions, ...init } as FheFetchOptions);
}

/**
 * Performs an HTTP request with automatic x402 FHE payment handling.
 *
 * V4.0 Flow:
 * 1. Fetch URL
 * 2. If 402 → encrypt amount, call cUSDC.confidentialTransfer() + verifier.recordPayment()
 * 3. Retry with Payment header containing txHash + verifierTxHash + nonce
 * 4. Return final response
 */
export async function fheFetch(
  url: string | URL,
  options: FheFetchOptions
): Promise<Response> {
  const {
    tokenAddress: _tokenAddress,
    verifierAddress: _verifierAddress,
    rpcUrl: _rpcUrl,
    signer,
    fhevmInstance,
    maxPayment,
    allowedNetworks,
    dryRun,
    timeoutMs,
    maxRetries,
    retryDelayMs,
    preferSingleTx,
    ...fetchOptions
  } = options;
  void _tokenAddress;
  void _verifierAddress;
  void _rpcUrl;

  const timeout = timeoutMs ?? 30_000;
  const retries = maxRetries ?? 0;
  const delay = retryDelayMs ?? 1_000;

  const response = await fetchWithTimeout(url, fetchOptions, timeout);

  if (response.status !== 402) return response;
  if (dryRun) return response;

  const responseForParsing = response.clone();

  const handler = new FhePaymentHandler(signer, fhevmInstance, {
    maxPayment,
    allowedNetworks,
  });

  let result: FhePaymentResult | null;
  // Encryption timeout is handled by the overall retry mechanism
  result = await handler.handlePaymentRequired(responseForParsing, { preferSingleTx });

  if (!result) return response;

  // Retry with Payment header (with optional retries for network issues)
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const retryHeaders = new Headers(fetchOptions.headers);
      retryHeaders.set("Payment", result.paymentHeader);

      const retryResponse = await fetchWithTimeout(
        url,
        { ...fetchOptions, headers: retryHeaders },
        timeout
      );

      return retryResponse;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        await sleep(delay * Math.pow(2, attempt)); // exponential backoff
      }
    }
  }

  throw new NetworkError(
    `Failed after ${retries + 1} attempts: ${lastError?.message}`,
    { url: String(url), retries },
    lastError ? { cause: lastError } : undefined
  );
}

/**
 * Like fheFetch but calls a callback after payment.
 */
export async function fheFetchWithCallback(
  url: string | URL,
  options: FheFetchOptions,
  onPayment: (result: FhePaymentResult, success: boolean) => void
): Promise<Response> {
  const {
    tokenAddress: _tokenAddress2,
    verifierAddress: _verifierAddress2,
    rpcUrl: _rpcUrl2,
    signer,
    fhevmInstance,
    maxPayment,
    allowedNetworks,
    dryRun,
    timeoutMs,
    preferSingleTx: preferSingleTx2,
    ...fetchOptions
  } = options;
  void _tokenAddress2;
  void _verifierAddress2;
  void _rpcUrl2;

  const timeout = timeoutMs ?? 30_000;

  const response = await fetchWithTimeout(url, fetchOptions, timeout);

  if (response.status !== 402 || dryRun) return response;

  const responseForParsing = response.clone();

  const handler = new FhePaymentHandler(signer, fhevmInstance, {
    maxPayment,
    allowedNetworks,
  });

  const result = await handler.handlePaymentRequired(responseForParsing, { preferSingleTx: preferSingleTx2 });
  if (!result) return response;

  const retryHeaders = new Headers(fetchOptions.headers);
  retryHeaders.set("Payment", result.paymentHeader);

  const retryResponse = await fetchWithTimeout(
    url,
    { ...fetchOptions, headers: retryHeaders },
    timeout
  );

  onPayment(result, retryResponse.ok);

  return retryResponse;
}

// ============================================================================
// Helpers
// ============================================================================

async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  if (timeoutMs <= 0) return fetch(url, init);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(`Request timed out after ${timeoutMs}ms`, {
        url: String(url),
        timeoutMs,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
