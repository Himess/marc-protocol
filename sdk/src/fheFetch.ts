import { ethers } from "ethers";
import { FhePaymentHandler } from "./fhePaymentHandler.js";
import type { FhePaymentResult } from "./fhePaymentHandler.js";
import type { FheFetchOptions } from "./types.js";

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
    ...fetchOptions
  } = options;
  void _poolAddress;
  void _rpcUrl;

  const response = await fetch(url, fetchOptions);

  if (response.status !== 402) return response;
  if (dryRun) return response;

  const responseForParsing = response.clone();

  const handler = new FhePaymentHandler(signer, fhevmInstance, {
    maxPayment,
    allowedNetworks,
  });

  let result: FhePaymentResult | null;
  result = await handler.handlePaymentRequired(responseForParsing);

  if (!result) return response;

  const retryHeaders = new Headers(fetchOptions.headers);
  retryHeaders.set("Payment", result.paymentHeader);

  const retryResponse = await fetch(url, {
    ...fetchOptions,
    headers: retryHeaders,
  });

  return retryResponse;
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
    ...fetchOptions
  } = options;
  void _poolAddress2;
  void _rpcUrl2;

  const response = await fetch(url, fetchOptions);

  if (response.status !== 402 || dryRun) return response;

  const responseForParsing = response.clone();

  const handler = new FhePaymentHandler(signer, fhevmInstance, {
    maxPayment,
    allowedNetworks,
  });

  const result = await handler.handlePaymentRequired(responseForParsing);
  if (!result) return response;

  const retryHeaders = new Headers(fetchOptions.headers);
  retryHeaders.set("Payment", result.paymentHeader);

  const retryResponse = await fetch(url, {
    ...fetchOptions,
    headers: retryHeaders,
  });

  onPayment(result, retryResponse.ok);

  return retryResponse;
}
