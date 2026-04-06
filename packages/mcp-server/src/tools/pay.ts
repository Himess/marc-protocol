// SPDX-License-Identifier: BUSL-1.1

import { Contract, ethers } from "ethers";
import type { Wallet } from "ethers";
import { TOKEN_ABI, VERIFIER_ABI, FHE_SCHEME } from "../config.js";
import type { ChainConfig } from "../config.js";

/**
 * FHE encrypted input interface (minimal).
 */
interface FhevmInstance {
  createEncryptedInput: (
    contractAddress: string,
    userAddress: string
  ) => {
    add64: (value: bigint | number) => void;
    encrypt: () => Promise<{ handles: string[]; inputProof: string }>;
  };
}

/** Payment requirements from 402 response */
interface PaymentRequirements {
  scheme: string;
  network: string;
  chainId: number;
  price: string;
  asset: string;
  tokenAddress: string;
  verifierAddress: string;
  recipientAddress: string;
  maxTimeoutSeconds: number;
}

/** 402 response body */
interface PaymentRequired {
  x402Version: number;
  accepts: PaymentRequirements[];
  error?: string;
}

/**
 * pay_x402 — Full x402 payment flow.
 *
 * 1. Fetch the URL
 * 2. If 402 → parse payment requirements
 * 3. Encrypt amount with FHE
 * 4. Call cUSDC.confidentialTransfer() (pay the server)
 * 5. Call verifier.recordPayment() (on-chain nonce)
 * 6. Retry the URL with Payment header
 * 7. Return the API response
 *
 * @returns Tool result text with payment details + API response
 */
export async function payX402(
  wallet: Wallet,
  chain: ChainConfig,
  url: string,
  method: string,
  fhevmInstance: FhevmInstance | null
): Promise<string> {
  // Step 1: Fetch the URL
  const initialResponse = await fetchWithTimeout(url, { method }, 30_000);

  // Not a 402 — return directly
  if (initialResponse.status !== 402) {
    const body = await initialResponse.text();
    return [
      `URL returned ${initialResponse.status} (not 402 — no payment required)`,
      "",
      `Status: ${initialResponse.status} ${initialResponse.statusText}`,
      `Response: ${body.substring(0, 2000)}`,
    ].join("\n");
  }

  // Step 2: Parse 402 payment requirements
  let paymentRequired: PaymentRequired;
  try {
    paymentRequired = (await initialResponse.json()) as PaymentRequired;
  } catch {
    throw new Error("Failed to parse 402 response body as JSON");
  }

  if (!paymentRequired || paymentRequired.x402Version !== 1 || !Array.isArray(paymentRequired.accepts)) {
    throw new Error("Invalid 402 response: missing x402Version or accepts array");
  }

  // Step 3: Select matching FHE requirement
  const requirement = paymentRequired.accepts.find((r) => r.scheme === FHE_SCHEME);

  if (!requirement) {
    const schemes = paymentRequired.accepts.map((r) => r.scheme).join(", ");
    throw new Error(`No matching FHE payment scheme found. Server accepts: ${schemes}`);
  }

  if (!fhevmInstance) {
    throw new Error(
      "FHE instance not initialized. Cannot make encrypted payment. " +
        "Set FHEVM_GATEWAY_URL environment variable or ensure @zama-fhe/relayer-sdk is available."
    );
  }

  const signerAddress = await wallet.getAddress();
  const amount = BigInt(requirement.price);
  const nonce = ethers.hexlify(ethers.randomBytes(32));

  // Step 4: Encrypt amount with FHE
  const input = fhevmInstance.createEncryptedInput(requirement.tokenAddress, signerAddress);
  input.add64(amount);

  const encrypted = await Promise.race([
    input.encrypt(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("FHE encryption timed out after 30s")), 30_000)
    ),
  ]);

  if (!encrypted.handles || encrypted.handles.length === 0) {
    throw new Error("FHE encryption returned no handles");
  }

  // Step 5: Single-TX payment via verifier.payAndRecord() (Zama operator pattern)
  // Requires agent to have set verifier as operator:
  //   cUSDC.setOperator(verifierAddress, type(uint48).max)
  const verifier = new Contract(requirement.verifierAddress, VERIFIER_ABI, wallet);

  let payTx;
  try {
    payTx = await verifier.payAndRecord(
      requirement.tokenAddress,
      requirement.recipientAddress,
      nonce,
      amount,
      encrypted.handles[0],
      encrypted.inputProof
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("UnauthorizedSpender") ||
      msg.includes("operator") ||
      msg.includes("ERC7984") ||
      msg.includes("not authorized") ||
      msg.includes("approval")
    ) {
      throw new Error(
        "Single-TX payment requires operator approval. Call cUSDC.setOperator(verifierAddress, type(uint48).max) first."
      );
    }
    throw new Error(`Single-TX payment failed: ${msg}`);
  }
  const payReceipt = await payTx.wait();

  if (!payReceipt || payReceipt.status === 0) {
    throw new Error(`Payment transaction reverted: ${payTx.hash}`);
  }

  // Step 6: Build payment header and retry
  const payloadData = {
    scheme: FHE_SCHEME,
    txHash: payTx.hash,
    verifierTxHash: "", // empty for single-TX (nonce recorded in same tx)
    nonce,
    from: signerAddress,
    chainId: requirement.chainId,
  };

  const signature = await wallet.signMessage(
    JSON.stringify(
      Object.keys(payloadData)
        .sort()
        .reduce((obj, key) => ({ ...obj, [key]: (payloadData as Record<string, unknown>)[key] }), {})
    )
  );

  const payload = { ...payloadData, signature };
  const paymentHeader = Buffer.from(JSON.stringify(payload)).toString("base64");

  // Step 7: Retry with Payment header
  const retryResponse = await fetchWithTimeout(
    url,
    {
      method,
      headers: { Payment: paymentHeader },
    },
    30_000
  );

  const responseBody = await retryResponse.text();
  const formattedPrice = (Number(amount) / 1_000_000).toFixed(6);

  return [
    `x402 payment completed (single-TX)`,
    "",
    `URL: ${url}`,
    `Price: ${formattedPrice} USDC`,
    `Recipient: ${requirement.recipientAddress}`,
    "",
    `Payment TX: ${chain.explorerUrl}/tx/${payTx.hash}`,
    `Nonce: ${nonce}`,
    `From: ${signerAddress}`,
    "",
    `API Response (${retryResponse.status}):`,
    responseBody.substring(0, 4000),
  ].join("\n");
}

// ============================================================================
// Helpers
// ============================================================================

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
