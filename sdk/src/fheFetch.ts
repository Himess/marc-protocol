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
 * Flow:
 * 1. Fetch URL
 * 2. If 402 → encrypt amount, call pool.pay(), get txHash
 * 3. Retry with Payment header containing txHash + nonce
 * 4. Return final response
 */
export async function fheFetch(
  url: string | URL,
  options: FheFetchOptions
): Promise<Response> {
  const {
    poolAddress: _poolAddress,
    rpcUrl: _rpcUrl,
    signer,
    fhevmInstance,
    maxPayment,
    allowedNetworks,
    dryRun,
    timeoutMs,
    maxRetries,
    retryDelayMs,
    memo,
    ...fetchOptions
  } = options;
  void _poolAddress;
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
    memo,
  });

  let result: FhePaymentResult | null;
  result = await handler.handlePaymentRequired(responseForParsing);

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
        await sleep(delay * (attempt + 1)); // linear backoff
      }
    }
  }

  throw new NetworkError(
    `Failed after ${retries + 1} attempts: ${lastError?.message}`,
    { url: String(url), retries }
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
    poolAddress: _poolAddress2,
    rpcUrl: _rpcUrl2,
    signer,
    fhevmInstance,
    maxPayment,
    allowedNetworks,
    dryRun,
    timeoutMs,
    memo,
    ...fetchOptions
  } = options;
  void _poolAddress2;
  void _rpcUrl2;

  const timeout = timeoutMs ?? 30_000;

  const response = await fetchWithTimeout(url, fetchOptions, timeout);

  if (response.status !== 402 || dryRun) return response;

  const responseForParsing = response.clone();

  const handler = new FhePaymentHandler(signer, fhevmInstance, {
    maxPayment,
    allowedNetworks,
    memo,
  });

  const result = await handler.handlePaymentRequired(responseForParsing);
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
