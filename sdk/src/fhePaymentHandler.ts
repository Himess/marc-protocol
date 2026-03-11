import { Contract, ethers } from "ethers";
import type {
  FhePaymentRequirements,
  FhePaymentPayload,
  FheBatchPaymentPayload,
  FhePaymentRequired,
  FhevmInstance,
} from "./types.js";
import { FHE_SCHEME } from "./types.js";
import { PaymentError, EncryptionError } from "./errors.js";

// ============================================================================
// Types
// ============================================================================

export interface FhePaymentHandlerOptions {
  maxPayment?: bigint;
  allowedNetworks?: string[];
}

export interface FhePaymentResult {
  paymentHeader: string;
  txHash: string;
  verifierTxHash: string;
  nonce: string;
}

/** V4.3 — Batch payment result */
export interface FheBatchPaymentResult {
  paymentHeader: string;
  txHash: string;
  verifierTxHash: string;
  nonce: string;
  requestCount: number;
  pricePerRequest: string;
}

// ============================================================================
// Handler
// ============================================================================

/**
 * Handles x402 FHE payment flows.
 *
 * V4.0 Flow (token-centric):
 * 1. Parse 402 response → extract payment requirements
 * 2. Select matching requirement
 * 3. Encrypt amount with fhevmjs
 * 4. Call cUSDC.confidentialTransfer() (fee-free agent-to-agent)
 * 5. Call verifier.recordPayment() (on-chain nonce)
 * 6. Return txHash + verifierTxHash + nonce for retry header
 */
export class FhePaymentHandler {
  private signer: ethers.Signer;
  private fhevmInstance: FhevmInstance;
  private options: FhePaymentHandlerOptions;

  constructor(
    signer: ethers.Signer,
    fhevmInstance: FhevmInstance,
    options: FhePaymentHandlerOptions = {}
  ) {
    this.signer = signer;
    this.fhevmInstance = fhevmInstance;
    this.options = options;
  }

  async parsePaymentRequired(
    response: Response
  ): Promise<FhePaymentRequired | null> {
    if (response.status !== 402) return null;
    try {
      const body = await response.json();
      if (!body || body.x402Version !== 1 || !Array.isArray(body.accepts)) {
        return null;
      }
      return body as FhePaymentRequired;
    } catch {
      return null;
    }
  }

  selectRequirement(
    requirements: FhePaymentRequirements[]
  ): FhePaymentRequirements | null {
    for (const req of requirements) {
      if (req.scheme !== FHE_SCHEME) continue;
      if (
        this.options.allowedNetworks?.length &&
        !this.options.allowedNetworks.includes(req.network)
      ) {
        continue;
      }
      if (this.options.maxPayment && this.options.maxPayment > 0n) {
        const price = BigInt(req.price);
        if (price > this.options.maxPayment) continue;
      }
      return req;
    }
    return null;
  }

  async createPayment(
    requirements: FhePaymentRequirements
  ): Promise<FhePaymentResult> {
    const signerAddress = await this.signer.getAddress();
    const amount = BigInt(requirements.price);

    // Create nonce
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    // Encrypt amount with fhevmjs
    let encrypted: { handles: string[]; inputProof: string };
    try {
      const input = this.fhevmInstance.createEncryptedInput(
        requirements.tokenAddress,
        signerAddress
      );
      input.add64(amount);
      encrypted = await input.encrypt();
    } catch (err) {
      throw new EncryptionError(
        `FHE encryption failed: ${err instanceof Error ? err.message : String(err)}`,
        { amount: amount.toString(), tokenAddress: requirements.tokenAddress }
      );
    }

    if (!encrypted.handles || encrypted.handles.length === 0) {
      throw new EncryptionError("FHE encryption returned no handles", {});
    }

    // Step 1: Call cUSDC.confidentialTransfer() — fee-free agent-to-agent transfer
    const tokenABI = [
      "function confidentialTransfer(address to, bytes32 encryptedAmount, bytes calldata inputProof) external returns (bytes32)",
    ];
    const token = new Contract(requirements.tokenAddress, tokenABI, this.signer);

    const tx = await token.confidentialTransfer(
      requirements.recipientAddress,
      encrypted.handles[0],
      encrypted.inputProof
    );
    const receipt = await tx.wait();

    if (!receipt || receipt.status === 0) {
      throw new PaymentError("Payment transaction failed", {
        txHash: tx.hash,
        to: requirements.recipientAddress,
        amount: amount.toString(),
      });
    }

    // Step 2: Call verifier.recordPayment() — on-chain nonce with minPrice
    const verifierABI = [
      "function recordPayment(address server, bytes32 nonce, uint64 minPrice) external",
    ];
    const verifier = new Contract(requirements.verifierAddress, verifierABI, this.signer);

    const vTx = await verifier.recordPayment(
      requirements.recipientAddress,
      nonce,
      amount
    );
    const vReceipt = await vTx.wait();

    if (!vReceipt || vReceipt.status === 0) {
      throw new PaymentError("Verifier recordPayment failed", {
        txHash: vTx.hash,
        nonce,
      });
    }

    // Build payment payload
    const payload: FhePaymentPayload = {
      scheme: FHE_SCHEME,
      txHash: tx.hash,
      verifierTxHash: vTx.hash,
      nonce,
      from: signerAddress,
      chainId: requirements.chainId,
    };

    const paymentHeader = encodePaymentHeader(payload);

    return {
      paymentHeader,
      txHash: tx.hash,
      verifierTxHash: vTx.hash,
      nonce,
    };
  }

  /**
   * V4.2 — Single-TX payment via verifier.payAndRecord().
   * Transfers cUSDC to server and records nonce in one transaction.
   * Requires the agent to have set the verifier as an operator on the token:
   *   cUSDC.setOperator(verifierAddress, type(uint48).max)
   */
  async createSingleTxPayment(
    requirements: FhePaymentRequirements
  ): Promise<FhePaymentResult> {
    const signerAddress = await this.signer.getAddress();
    const amount = BigInt(requirements.price);
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    // Encrypt amount with fhevmjs
    let encrypted: { handles: string[]; inputProof: string };
    try {
      const input = this.fhevmInstance.createEncryptedInput(
        requirements.tokenAddress,
        signerAddress
      );
      input.add64(amount);
      encrypted = await input.encrypt();
    } catch (err) {
      throw new EncryptionError(
        `FHE encryption failed: ${err instanceof Error ? err.message : String(err)}`,
        { amount: amount.toString(), tokenAddress: requirements.tokenAddress }
      );
    }

    if (!encrypted.handles || encrypted.handles.length === 0) {
      throw new EncryptionError("FHE encryption returned no handles", {});
    }

    // Single TX: verifier.payAndRecord() — does confidentialTransferFrom + recordPayment
    // NOTE: Requires agent to have set verifier as operator:
    //   cUSDC.setOperator(verifierAddress, type(uint48).max)
    const verifierABI = [
      "function payAndRecord(address token, address server, bytes32 nonce, uint64 minPrice, bytes32 encryptedAmount, bytes calldata inputProof) external",
    ];
    const verifier = new Contract(requirements.verifierAddress, verifierABI, this.signer);

    let tx;
    try {
      tx = await verifier.payAndRecord(
        requirements.tokenAddress,
        requirements.recipientAddress,
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
        throw new PaymentError(
          "Single-TX payment requires operator approval. Call cUSDC.setOperator(verifierAddress, type(uint48).max) first.",
          { verifier: requirements.verifierAddress, token: requirements.tokenAddress }
        );
      }
      throw new PaymentError(
        `Single-TX payment failed: ${msg}. If this is an authorization error, ensure the verifier is set as an operator on the token via cUSDC.setOperator(verifierAddress, type(uint48).max).`,
        {
          to: requirements.recipientAddress,
          amount: amount.toString(),
        }
      );
    }
    const receipt = await tx.wait();

    if (!receipt || receipt.status === 0) {
      throw new PaymentError("Single-TX payment transaction reverted", {
        txHash: tx.hash,
        to: requirements.recipientAddress,
        amount: amount.toString(),
      });
    }

    const payload: FhePaymentPayload = {
      scheme: FHE_SCHEME,
      txHash: tx.hash,
      verifierTxHash: "", // empty for single-TX (nonce recorded in same tx)
      nonce,
      from: signerAddress,
      chainId: requirements.chainId,
    };

    return {
      paymentHeader: encodePaymentHeader(payload),
      txHash: tx.hash,
      verifierTxHash: "",
      nonce,
    };
  }

  async handlePaymentRequired(
    response: Response,
    options?: { preferSingleTx?: boolean }
  ): Promise<FhePaymentResult | null> {
    const paymentRequired = await this.parsePaymentRequired(response);
    if (!paymentRequired) return null;

    const requirement = this.selectRequirement(paymentRequired.accepts);
    if (!requirement) return null;

    if (options?.preferSingleTx) {
      return this.createSingleTxPayment(requirement);
    }
    return this.createPayment(requirement);
  }

  // ==========================================================================
  // V4.3 — BATCH PREPAYMENT
  // ==========================================================================

  /**
   * Create a batch prepayment: single encrypted transfer for (requestCount * pricePerRequest)
   * plus recordBatchPayment on the verifier.
   *
   * @param requirements - The payment requirements from the 402 response
   * @param requestCount - Number of requests to prepay for
   * @param pricePerRequest - Price per request in USDC (6 decimals string, e.g. "100000" = 0.10 USDC)
   */
  async createBatchPayment(
    requirements: FhePaymentRequirements,
    requestCount: number,
    pricePerRequest: string
  ): Promise<FheBatchPaymentResult> {
    if (requestCount <= 0) {
      throw new PaymentError("Request count must be > 0", { requestCount });
    }

    const signerAddress = await this.signer.getAddress();
    const perRequest = BigInt(pricePerRequest);

    if (perRequest > BigInt("0xFFFFFFFFFFFFFFFF")) {
      throw new PaymentError("pricePerRequest exceeds uint64 max", { pricePerRequest });
    }

    const totalAmount = perRequest * BigInt(requestCount);

    if (totalAmount > BigInt("0xFFFFFFFFFFFFFFFF")) {
      throw new PaymentError("Batch total exceeds uint64 max", {
        totalAmount: totalAmount.toString(),
        requestCount,
        pricePerRequest,
      });
    }

    // Create nonce
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    // Encrypt total amount with fhevmjs
    let encrypted: { handles: string[]; inputProof: string };
    try {
      const input = this.fhevmInstance.createEncryptedInput(
        requirements.tokenAddress,
        signerAddress
      );
      input.add64(totalAmount);
      encrypted = await input.encrypt();
    } catch (err) {
      throw new EncryptionError(
        `FHE encryption failed: ${err instanceof Error ? err.message : String(err)}`,
        { amount: totalAmount.toString(), tokenAddress: requirements.tokenAddress }
      );
    }

    if (!encrypted.handles || encrypted.handles.length === 0) {
      throw new EncryptionError("FHE encryption returned no handles", {});
    }

    // Step 1: Call cUSDC.confidentialTransfer() — fee-free agent-to-agent transfer
    const tokenABI = [
      "function confidentialTransfer(address to, bytes32 encryptedAmount, bytes calldata inputProof) external returns (bytes32)",
    ];
    const token = new Contract(requirements.tokenAddress, tokenABI, this.signer);

    const tx = await token.confidentialTransfer(
      requirements.recipientAddress,
      encrypted.handles[0],
      encrypted.inputProof
    );
    const receipt = await tx.wait();

    if (!receipt || receipt.status === 0) {
      throw new PaymentError("Batch payment transfer failed", {
        txHash: tx.hash,
        to: requirements.recipientAddress,
        amount: totalAmount.toString(),
      });
    }

    // Step 2: Call verifier.recordBatchPayment() — on-chain batch nonce
    const verifierABI = [
      "function recordBatchPayment(address server, bytes32 nonce, uint32 requestCount, uint64 pricePerRequest) external",
    ];
    const verifier = new Contract(requirements.verifierAddress, verifierABI, this.signer);

    const vTx = await verifier.recordBatchPayment(
      requirements.recipientAddress,
      nonce,
      requestCount,
      perRequest
    );
    const vReceipt = await vTx.wait();

    if (!vReceipt || vReceipt.status === 0) {
      throw new PaymentError("Verifier recordBatchPayment failed", {
        txHash: vTx.hash,
        nonce,
      });
    }

    // Build batch payment payload
    const payload: FheBatchPaymentPayload = {
      scheme: FHE_SCHEME,
      txHash: tx.hash,
      verifierTxHash: vTx.hash,
      nonce,
      from: signerAddress,
      chainId: requirements.chainId,
      requestCount,
      pricePerRequest,
    };

    const paymentHeader = encodeBatchPaymentHeader(payload);

    return {
      paymentHeader,
      txHash: tx.hash,
      verifierTxHash: vTx.hash,
      nonce,
      requestCount,
      pricePerRequest,
    };
  }
}

// ============================================================================
// Encoding
// ============================================================================

function encodePaymentHeader(payload: FhePaymentPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json).toString("base64");
}

function encodeBatchPaymentHeader(payload: FheBatchPaymentPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json).toString("base64");
}

export function decodePaymentHeader(header: string): FhePaymentPayload {
  const json = Buffer.from(header, "base64").toString("utf-8");
  const parsed = JSON.parse(json);
  if (
    !parsed ||
    typeof parsed.scheme !== "string" ||
    typeof parsed.txHash !== "string" ||
    typeof parsed.verifierTxHash !== "string" ||
    typeof parsed.nonce !== "string" ||
    typeof parsed.from !== "string" ||
    typeof parsed.chainId !== "number"
  ) {
    throw new Error("Invalid payment payload: missing required fields");
  }
  return parsed as FhePaymentPayload;
}

/** Decode a batch payment header (base64 JSON) */
export function decodeBatchPaymentHeader(header: string): FheBatchPaymentPayload {
  const json = Buffer.from(header, "base64").toString("utf-8");
  const parsed = JSON.parse(json);
  if (
    !parsed ||
    typeof parsed.scheme !== "string" ||
    typeof parsed.txHash !== "string" ||
    typeof parsed.nonce !== "string" ||
    typeof parsed.from !== "string" ||
    typeof parsed.chainId !== "number" ||
    typeof parsed.requestCount !== "number" ||
    typeof parsed.pricePerRequest !== "string"
  ) {
    throw new Error("Invalid batch payment payload: missing required fields");
  }
  return parsed as FheBatchPaymentPayload;
}
