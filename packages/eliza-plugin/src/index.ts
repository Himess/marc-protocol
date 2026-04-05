// SPDX-License-Identifier: BUSL-1.1

/**
 * MARC Protocol — ElizaOS FHE Payment Plugin
 *
 * Provides five FHE confidential payment actions for ElizaOS agents:
 * - MARC_WRAP:     Wrap USDC into encrypted cUSDC (ERC-7984)
 * - MARC_UNWRAP:   Unwrap cUSDC back to USDC (step 1 of 2, KMS finalization needed)
 * - MARC_TRANSFER: Confidential transfer of encrypted cUSDC
 * - MARC_BALANCE:  Check encrypted balance handle and public USDC balance
 * - MARC_PAY:      Full x402 payment flow (402 fetch, encrypt, pay, verify)
 *
 * Usage:
 *
 *   import { marcPlugin } from "@marc-protocol/eliza-plugin";
 *
 *   // Register with ElizaOS agent
 *   agent.registerPlugin(marcPlugin);
 */

// ============================================================================
// Minimal interface types (avoid hard dependency on ethers / @zama-fhe)
// ============================================================================

/** Minimal ethers.Signer */
export interface Signer {
  getAddress(): Promise<string>;
  signMessage(message: string): Promise<string>;
}

/** Minimal @zama-fhe/relayer-sdk FhevmInstance */
export interface FhevmInstance {
  createEncryptedInput: (
    contractAddress: string,
    userAddress: string
  ) => FhevmEncryptedInput;
}

export interface FhevmEncryptedInput {
  add64: (value: bigint | number) => void;
  encrypt: () => Promise<{ handles: string[]; inputProof: string }>;
}

// ============================================================================
// ElizaOS types
// ============================================================================

export interface ElizaAction {
  name: string;
  description: string;
  validate: (params: Record<string, unknown>) => boolean;
  handler: (
    params: Record<string, unknown>,
    context: ElizaContext
  ) => Promise<ElizaResult>;
  examples: string[][];
}

export interface ElizaPlugin {
  name: string;
  description: string;
  actions: ElizaAction[];
}

export interface ElizaContext {
  /** Ethers signer for sending transactions */
  signer: Signer;
  /** Zama FhevmInstance for FHE encryption (required for transfer, unwrap, pay) */
  fhevmInstance?: FhevmInstance;
  /** Contract addresses override (defaults to Sepolia) */
  addresses?: MarcAddresses;
}

export interface ElizaResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

// ============================================================================
// Contract ABIs (minimal, from marc-protocol contracts)
// ============================================================================

export const TOKEN_ABI = [
  "function name() external view returns (string)",
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
  "function confidentialTotalSupply() external view returns (bytes32)",
  "function confidentialBalanceOf(address account) external view returns (bytes32)",
  "function confidentialTransfer(address to, bytes32 encryptedAmount, bytes calldata inputProof) external returns (bytes32)",
  "function wrap(address to, uint256 amount) external",
  "function unwrap(address from, address to, bytes32 encryptedAmount, bytes calldata inputProof) external",
  "function finalizeUnwrap(bytes32 burntAmount, uint64 burntAmountCleartext, bytes calldata decryptionProof) external",
  "function underlying() external view returns (address)",
  "function paused() external view returns (bool)",
] as const;

export const VERIFIER_ABI = [
  "function recordPayment(address server, bytes32 nonce, uint64 minPrice) external",
  "function usedNonces(bytes32 nonce) external view returns (bool)",
  "function trustedToken() external view returns (address)",
  "function payAndRecord(address token, address server, bytes32 nonce, uint64 minPrice, bytes32 encryptedAmount, bytes calldata inputProof) external",
  "event PaymentVerified(address indexed payer, address indexed server, bytes32 indexed nonce, uint64 minPrice)",
  "event PayAndRecordCompleted(address indexed payer, address indexed server, bytes32 indexed nonce, address token, uint64 minPrice)",
] as const;

export const USDC_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
] as const;

// ============================================================================
// Chain addresses
// ============================================================================

export interface MarcAddresses {
  tokenAddress: string;
  verifierAddress: string;
  usdcAddress: string;
}

/** Deployed contract addresses on Ethereum Sepolia (V4.3) */
export const MARC_SEPOLIA_ADDRESSES: MarcAddresses = {
  tokenAddress: "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D",
  verifierAddress: "0x4503A7aee235aBD10e6064BBa8E14235fdF041f4",
  usdcAddress: "0xc89e913676B034f8b38E49f7508803d1cDEC9F4f",
};

// ============================================================================
// Internal helpers
// ============================================================================

const ZERO_HANDLE = "0x" + "00".repeat(32);
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const FHE_SCHEME = "fhe-confidential-v1";

function isValidAddress(addr: string): boolean {
  return ADDRESS_RE.test(addr);
}

function getAddresses(context: ElizaContext): MarcAddresses {
  return context.addresses ?? MARC_SEPOLIA_ADDRESSES;
}

/** Parse human-readable amount (e.g. "2.5") to raw USDC units (6 decimals) */
function parseAmount(amountStr: string): bigint {
  const amountFloat = parseFloat(amountStr);
  if (isNaN(amountFloat) || amountFloat <= 0) {
    throw new Error("Invalid amount — must be a positive number");
  }
  return BigInt(Math.round(amountFloat * 1_000_000));
}

/** Dynamic import to avoid bundling ethers at module level */
async function createContract(
  address: string,
  abi: readonly string[],
  signer: Signer
): Promise<any> {
  const { Contract } = await import("ethers");
  return new Contract(address, abi as string[], signer as any);
}

async function randomNonce(): Promise<string> {
  const { ethers } = await import("ethers");
  return ethers.hexlify(ethers.randomBytes(32));
}

/** Build canonical message for EIP-191 signing */
function canonicalMessage(data: Record<string, unknown>): string {
  const sorted = Object.keys(data)
    .filter((k) => k !== "signature")
    .sort()
    .reduce(
      (obj, key) => ({ ...obj, [key]: data[key] }),
      {} as Record<string, unknown>
    );
  return JSON.stringify(sorted);
}

// ============================================================================
// Action: MARC_WRAP
// ============================================================================

export const marcWrapAction: ElizaAction = {
  name: "MARC_WRAP",
  description:
    "Wrap USDC into cUSDC (ERC-7984 confidential token). Converts public USDC into an encrypted balance using Fully Homomorphic Encryption. Amount in USDC (e.g. '100' for 100 USDC).",

  validate(params: Record<string, unknown>): boolean {
    const amount = params.amount;
    if (typeof amount !== "string" && typeof amount !== "number") return false;
    const parsed = parseFloat(String(amount));
    return !isNaN(parsed) && parsed > 0;
  },

  async handler(
    params: Record<string, unknown>,
    context: ElizaContext
  ): Promise<ElizaResult> {
    try {
      const amountStr = String(params.amount);
      const rawAmount = parseAmount(amountStr);
      const addresses = getAddresses(context);
      const signerAddress = await context.signer.getAddress();
      const to =
        typeof params.to === "string" && isValidAddress(params.to)
          ? params.to
          : signerAddress;

      // Approve USDC spending
      const usdc = await createContract(
        addresses.usdcAddress,
        USDC_ABI as unknown as string[],
        context.signer
      );
      const approveTx = await usdc.approve(addresses.tokenAddress, rawAmount);
      await approveTx.wait();

      // Wrap USDC -> cUSDC
      const token = await createContract(
        addresses.tokenAddress,
        TOKEN_ABI as unknown as string[],
        context.signer
      );
      const tx = await token.wrap(to, rawAmount);
      const receipt = await tx.wait();

      return {
        success: true,
        message: `Wrapped ${amountStr} USDC into cUSDC. TX: ${receipt.hash}`,
        data: {
          action: "wrap",
          amount: amountStr,
          to,
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
        },
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, message: `Wrap failed: ${msg}` };
    }
  },

  examples: [
    [
      "user: wrap 100 USDC to cUSDC",
      "assistant: I'll wrap 100 USDC into encrypted cUSDC for you.",
    ],
    [
      "user: I need private tokens",
      "assistant: Let me wrap your USDC into confidential cUSDC.",
    ],
    [
      "user: convert 50 USDC to encrypted",
      "assistant: Wrapping 50 USDC into cUSDC using FHE encryption.",
    ],
  ],
};

// ============================================================================
// Action: MARC_UNWRAP
// ============================================================================

export const marcUnwrapAction: ElizaAction = {
  name: "MARC_UNWRAP",
  description:
    "Unwrap cUSDC back to USDC (step 1 of 2). Encrypts the unwrap amount and submits on-chain. After KMS decryption, call finalizeUnwrap to complete.",

  validate(params: Record<string, unknown>): boolean {
    const amount = params.amount;
    if (typeof amount !== "string" && typeof amount !== "number") return false;
    const parsed = parseFloat(String(amount));
    return !isNaN(parsed) && parsed > 0;
  },

  async handler(
    params: Record<string, unknown>,
    context: ElizaContext
  ): Promise<ElizaResult> {
    try {
      if (!context.fhevmInstance) {
        return {
          success: false,
          message:
            "fhevmInstance is required for unwrap — provide it in ElizaContext",
        };
      }

      const amountStr = String(params.amount);
      const rawAmount = parseAmount(amountStr);
      const addresses = getAddresses(context);
      const signerAddress = await context.signer.getAddress();

      // Encrypt the unwrap amount
      const encInput = context.fhevmInstance.createEncryptedInput(
        addresses.tokenAddress,
        signerAddress
      );
      encInput.add64(rawAmount);
      const encrypted = await encInput.encrypt();

      if (!encrypted.handles || encrypted.handles.length === 0) {
        return {
          success: false,
          message: "FHE encryption returned no handles",
        };
      }

      // Call unwrap(from, to, encryptedAmount, inputProof)
      const token = await createContract(
        addresses.tokenAddress,
        TOKEN_ABI as unknown as string[],
        context.signer
      );
      const tx = await token.unwrap(
        signerAddress,
        signerAddress,
        encrypted.handles[0],
        encrypted.inputProof
      );
      const receipt = await tx.wait();

      return {
        success: true,
        message: `Unwrap of ${amountStr} cUSDC requested. TX: ${receipt.hash}. Awaiting KMS decryption before finalization.`,
        data: {
          action: "unwrap_requested",
          amount: amountStr,
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          note: "Step 1 complete. After KMS processes the decryption, call finalizeUnwrap on the token contract.",
        },
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, message: `Unwrap failed: ${msg}` };
    }
  },

  examples: [
    [
      "user: unwrap 50 cUSDC back to USDC",
      "assistant: I'll unwrap 50 cUSDC back to regular USDC for you.",
    ],
    [
      "user: convert my encrypted tokens to USDC",
      "assistant: Initiating cUSDC unwrap back to USDC.",
    ],
    [
      "user: I want to cash out my private balance",
      "assistant: Let me unwrap your cUSDC to get plain USDC back.",
    ],
  ],
};

// ============================================================================
// Action: MARC_TRANSFER
// ============================================================================

export const marcTransferAction: ElizaAction = {
  name: "MARC_TRANSFER",
  description:
    "Send encrypted cUSDC to another address using FHE. The transfer amount is encrypted on-chain. Requires 'to' (Ethereum address) and 'amount' (in USDC).",

  validate(params: Record<string, unknown>): boolean {
    const to = params.to;
    const amount = params.amount;

    if (typeof to !== "string" || !isValidAddress(to)) return false;
    if (typeof amount !== "string" && typeof amount !== "number") return false;

    const parsed = parseFloat(String(amount));
    return !isNaN(parsed) && parsed > 0;
  },

  async handler(
    params: Record<string, unknown>,
    context: ElizaContext
  ): Promise<ElizaResult> {
    try {
      if (!context.fhevmInstance) {
        return {
          success: false,
          message:
            "fhevmInstance is required for confidential transfer — provide it in ElizaContext",
        };
      }

      const to = String(params.to);
      const amountStr = String(params.amount);
      const rawAmount = parseAmount(amountStr);
      const addresses = getAddresses(context);
      const signerAddress = await context.signer.getAddress();

      // Encrypt amount
      const encInput = context.fhevmInstance.createEncryptedInput(
        addresses.tokenAddress,
        signerAddress
      );
      encInput.add64(rawAmount);
      const encrypted = await encInput.encrypt();

      if (!encrypted.handles || encrypted.handles.length === 0) {
        return {
          success: false,
          message: "FHE encryption returned no handles",
        };
      }

      // Call confidentialTransfer(to, encryptedAmount, inputProof)
      const token = await createContract(
        addresses.tokenAddress,
        TOKEN_ABI as unknown as string[],
        context.signer
      );
      const tx = await token.confidentialTransfer(
        to,
        encrypted.handles[0],
        encrypted.inputProof
      );
      const receipt = await tx.wait();

      return {
        success: true,
        message: `Sent ${amountStr} cUSDC to ${to}. TX: ${receipt.hash}`,
        data: {
          action: "confidential_transfer",
          to,
          amount: amountStr,
          txHash: receipt.hash,
          encryptedHandle: encrypted.handles[0],
          blockNumber: receipt.blockNumber,
        },
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, message: `Transfer failed: ${msg}` };
    }
  },

  examples: [
    [
      "user: send 10 cUSDC to 0xAbC123...",
      "assistant: I'll send 10 encrypted cUSDC to that address.",
    ],
    [
      "user: transfer 5 private USDC to my friend",
      "assistant: Sending 5 cUSDC confidentially using FHE encryption.",
    ],
    [
      "user: pay 0xDeF456... 25 cUSDC privately",
      "assistant: Transferring 25 cUSDC using encrypted transfer.",
    ],
  ],
};

// ============================================================================
// Action: MARC_BALANCE
// ============================================================================

export const marcBalanceAction: ElizaAction = {
  name: "MARC_BALANCE",
  description:
    "Check the wallet's public USDC balance and encrypted cUSDC balance handle. The encrypted balance can only be decrypted via KMS by the holder.",

  validate(_params: Record<string, unknown>): boolean {
    // No params required — balance always checks the signer's address
    // Optionally accepts 'address' to check a specific account
    if (_params.address && typeof _params.address === "string") {
      return isValidAddress(_params.address);
    }
    return true;
  },

  async handler(
    params: Record<string, unknown>,
    context: ElizaContext
  ): Promise<ElizaResult> {
    try {
      const addresses = getAddresses(context);
      const signerAddress = await context.signer.getAddress();
      const address =
        typeof params.address === "string" && isValidAddress(params.address)
          ? params.address
          : signerAddress;

      // Check public USDC balance
      const usdc = await createContract(
        addresses.usdcAddress,
        USDC_ABI as unknown as string[],
        context.signer
      );
      const publicBalance: bigint = await usdc.balanceOf(address);
      const balanceUSDC = (Number(publicBalance) / 1_000_000).toFixed(2);

      // Check encrypted cUSDC balance handle
      const token = await createContract(
        addresses.tokenAddress,
        TOKEN_ABI as unknown as string[],
        context.signer
      );

      let encryptedBalanceHandle: string = ZERO_HANDLE;
      try {
        encryptedBalanceHandle = await token.confidentialBalanceOf(address);
      } catch {
        // confidentialBalanceOf may not be available on mock/local networks
      }

      const hasEncryptedBalance = encryptedBalanceHandle !== ZERO_HANDLE;

      return {
        success: true,
        message: `Public USDC: ${balanceUSDC}, Encrypted cUSDC balance: ${hasEncryptedBalance ? "yes" : "none"}`,
        data: {
          action: "balance",
          walletAddress: address,
          publicBalanceUSDC: balanceUSDC,
          publicBalanceRaw: publicBalance.toString(),
          encryptedBalanceHandle,
          hasEncryptedBalance,
          note: "Encrypted cUSDC balance handle shown. Decrypting the actual amount requires KMS.",
        },
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, message: `Balance check failed: ${msg}` };
    }
  },

  examples: [
    [
      "user: check my balance",
      "assistant: Let me check your USDC and cUSDC balances.",
    ],
    [
      "user: how much cUSDC do I have?",
      "assistant: I'll check your encrypted cUSDC balance.",
    ],
    [
      "user: what's my wallet balance?",
      "assistant: Checking your public USDC and encrypted cUSDC balances.",
    ],
  ],
};

// ============================================================================
// Action: MARC_PAY
// ============================================================================

export const marcPayAction: ElizaAction = {
  name: "MARC_PAY",
  description:
    "Full x402 payment flow against a protected resource. Fetches a URL, handles the 402 response, encrypts payment with FHE, records the nonce on-chain, and retries with a Payment header.",

  validate(params: Record<string, unknown>): boolean {
    const url = params.url;
    if (typeof url !== "string" || !url.startsWith("http")) return false;
    return true;
  },

  async handler(
    params: Record<string, unknown>,
    context: ElizaContext
  ): Promise<ElizaResult> {
    try {
      if (!context.fhevmInstance) {
        return {
          success: false,
          message:
            "fhevmInstance is required for x402 payment — provide it in ElizaContext",
        };
      }

      const url = String(params.url);
      const maxPayment =
        typeof params.maxPayment === "string"
          ? BigInt(params.maxPayment)
          : typeof params.maxPayment === "bigint"
            ? params.maxPayment
            : undefined;
      const addresses = getAddresses(context);
      const signerAddress = await context.signer.getAddress();

      // Step 1: Fetch the resource — expect 402
      const response = await fetch(url);
      if (response.status !== 402) {
        return {
          success: false,
          message: `Resource did not return 402 (got ${response.status})`,
          data: { status: response.status, url },
        };
      }

      // Step 2: Parse 402 body
      let body: any;
      try {
        body = await response.json();
      } catch {
        return {
          success: false,
          message: "Failed to parse 402 response body",
          data: { url },
        };
      }

      if (!body || body.x402Version !== 1 || !Array.isArray(body.accepts)) {
        return {
          success: false,
          message: "Invalid 402 response format",
          data: { body },
        };
      }

      // Select matching requirement
      const requirement = body.accepts.find((r: any) => {
        if (r.scheme !== FHE_SCHEME) return false;
        if (maxPayment && maxPayment > 0n && BigInt(r.price) > maxPayment)
          return false;
        return true;
      });

      if (!requirement) {
        return {
          success: false,
          message: "No matching FHE payment requirement found",
          data: {
            schemes: body.accepts.map((r: any) => r.scheme),
            url,
          },
        };
      }

      const amount = BigInt(requirement.price);
      const nonce = await randomNonce();

      // Step 3: Encrypt and transfer
      const encInput = context.fhevmInstance.createEncryptedInput(
        addresses.tokenAddress,
        signerAddress
      );
      encInput.add64(amount);
      const encrypted = await encInput.encrypt();

      if (!encrypted.handles || encrypted.handles.length === 0) {
        return {
          success: false,
          message: "FHE encryption returned no handles",
        };
      }

      const token = await createContract(
        addresses.tokenAddress,
        TOKEN_ABI as unknown as string[],
        context.signer
      );
      const transferTx = await token.confidentialTransfer(
        requirement.recipientAddress,
        encrypted.handles[0],
        encrypted.inputProof
      );
      const transferReceipt = await transferTx.wait();

      // Step 4: Record nonce via verifier
      const verifier = await createContract(
        addresses.verifierAddress,
        VERIFIER_ABI as unknown as string[],
        context.signer
      );
      const verifierTx = await verifier.recordPayment(
        requirement.recipientAddress,
        nonce,
        amount
      );
      const verifierReceipt = await verifierTx.wait();

      // Step 5: Build Payment header and retry
      const payloadData: Record<string, unknown> = {
        scheme: FHE_SCHEME,
        txHash: transferReceipt.hash,
        verifierTxHash: verifierReceipt.hash,
        nonce,
        from: signerAddress,
        chainId: 11155111,
      };
      const signature = await context.signer.signMessage(
        canonicalMessage(payloadData)
      );
      const payload = { ...payloadData, signature };
      const paymentHeader = Buffer.from(JSON.stringify(payload)).toString(
        "base64"
      );

      let resourceResponse: { status: number; statusText: string } | undefined;
      try {
        const retryRes = await fetch(url, {
          headers: { Payment: paymentHeader },
        });
        resourceResponse = {
          status: retryRes.status,
          statusText: retryRes.statusText,
        };
      } catch {
        // Retry failed but payment was made
      }

      return {
        success: true,
        message: `Payment of ${(Number(amount) / 1_000_000).toFixed(2)} USDC completed for ${url}`,
        data: {
          action: "x402_payment",
          transferTxHash: transferReceipt.hash,
          verifierTxHash: verifierReceipt.hash,
          nonce,
          paymentHeader,
          resourceUrl: url,
          resourceResponse: resourceResponse as any,
        },
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, message: `x402 payment failed: ${msg}` };
    }
  },

  examples: [
    [
      "user: pay for access to https://api.example.com/premium",
      "assistant: I'll handle the x402 FHE payment to access that resource.",
    ],
    [
      "user: access this paid API endpoint",
      "assistant: Let me make an encrypted payment to unlock the resource.",
    ],
    [
      "user: use cUSDC to pay for https://data.example.com/report",
      "assistant: Making a confidential x402 payment to access the report.",
    ],
  ],
};

// ============================================================================
// Plugin export
// ============================================================================

/** MARC Protocol ElizaOS Plugin — registers all 5 FHE payment actions */
export const marcPlugin: ElizaPlugin = {
  name: "marc-protocol",
  description:
    "MARC Protocol FHE payment plugin for ElizaOS. Provides wrap, unwrap, transfer, balance check, and x402 payment actions using Fully Homomorphic Encryption on confidential USDC (cUSDC).",
  actions: [
    marcWrapAction,
    marcUnwrapAction,
    marcTransferAction,
    marcBalanceAction,
    marcPayAction,
  ],
};

export default marcPlugin;
