import { Contract, ethers } from "ethers";
import type {
  FhePaymentRequirements,
  FhePaymentPayload,
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
  /** Optional memo to attach to payments (bytes32 hex). Defaults to 0x0. */
  memo?: string;
}

export interface FhePaymentResult {
  paymentHeader: string;
  txHash: string;
  nonce: string;
}

// ============================================================================
// Handler
// ============================================================================

/**
 * Handles x402 FHE payment flows.
 *
 * Flow:
 * 1. Parse 402 response → extract payment requirements
 * 2. Select matching requirement
 * 3. Encrypt amount with fhevmjs
 * 4. Call pool.pay() on-chain (client pays gas directly)
 * 5. Return txHash + nonce for retry header
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
        requirements.poolAddress,
        signerAddress
      );
      input.add64(amount);
      encrypted = await input.encrypt();
    } catch (err) {
      throw new EncryptionError(
        `FHE encryption failed: ${err instanceof Error ? err.message : String(err)}`,
        { amount: amount.toString(), poolAddress: requirements.poolAddress }
      );
    }

    // Call pool.pay() on-chain
    const poolABI = [
      "function pay(address to, bytes32 encryptedAmount, bytes calldata inputProof, uint64 minPrice, bytes32 nonce, bytes32 memo) external",
    ];
    const pool = new Contract(requirements.poolAddress, poolABI, this.signer);

    const memo = this.options.memo || ethers.ZeroHash;
    const tx = await pool.pay(
      requirements.recipientAddress,
      encrypted.handles[0],
      encrypted.inputProof,
      amount,
      nonce,
      memo
    );
    const receipt = await tx.wait();

    if (!receipt || receipt.status === 0) {
      throw new PaymentError("Payment transaction failed", {
        txHash: tx.hash,
        to: requirements.recipientAddress,
        amount: amount.toString(),
      });
    }

    // Build payment payload
    const payload: FhePaymentPayload = {
      scheme: FHE_SCHEME,
      txHash: tx.hash,
      nonce,
      from: signerAddress,
      chainId: requirements.chainId,
    };

    const paymentHeader = encodePaymentHeader(payload);

    return {
      paymentHeader,
      txHash: tx.hash,
      nonce,
    };
  }

  async handlePaymentRequired(
    response: Response
  ): Promise<FhePaymentResult | null> {
    const paymentRequired = await this.parsePaymentRequired(response);
    if (!paymentRequired) return null;

    const requirement = this.selectRequirement(paymentRequired.accepts);
    if (!requirement) return null;

    return this.createPayment(requirement);
  }
}

// ============================================================================
// Encoding
// ============================================================================

function encodePaymentHeader(payload: FhePaymentPayload): string {
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
    typeof parsed.nonce !== "string" ||
    typeof parsed.from !== "string" ||
    typeof parsed.chainId !== "number"
  ) {
    throw new Error("Invalid payment payload: missing required fields");
  }
  return parsed as FhePaymentPayload;
}
