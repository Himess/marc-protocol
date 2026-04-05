// SPDX-License-Identifier: BUSL-1.1

/**
 * MARC Protocol — Google A2A (Agent-to-Agent) Plugin
 *
 * Exposes MARC Protocol FHE confidential payment capabilities as an A2A Skill
 * for Google's Agent-to-Agent protocol. Each action (wrap, unwrap, transfer,
 * balance, pay) is registered with a JSON Schema input definition and an
 * async handler that calls ethers.js contract methods.
 *
 * Usage:
 *
 *   import { MarcA2ASkill } from "@marc-protocol/a2a-plugin";
 *
 *   const skill = new MarcA2ASkill();
 *   const descriptor = skill.getSkillDescriptor();
 *   const result = await skill.executeAction("marc_wrap", params, context);
 */

// ============================================================================
// Minimal interface types (avoid hard dependency on ethers / @zama-fhe)
// ============================================================================

/** Minimal ethers.Signer — only the methods we actually call */
export interface Signer {
  getAddress(): Promise<string>;
  signMessage(message: string): Promise<string>;
}

/** Minimal @zama-fhe/relayer-sdk FhevmInstance */
export interface FhevmInstance {
  createEncryptedInput: (contractAddress: string, userAddress: string) => FhevmEncryptedInput;
}

export interface FhevmEncryptedInput {
  add64: (value: bigint | number) => void;
  addAddress: (value: string) => void;
  encrypt: () => Promise<{ handles: string[]; inputProof: string }>;
}

// ============================================================================
// A2A Protocol types
// ============================================================================

/** Google A2A Skill descriptor — advertises agent capabilities */
export interface A2ASkill {
  id: string;
  name: string;
  description: string;
  actions: A2AAction[];
}

/** Individual action within a skill */
export interface A2AAction {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  handler: (params: any, context: A2AContext) => Promise<A2AResult>;
}

/** Runtime context passed to action handlers */
export interface A2AContext {
  signer: Signer;
  fhevmInstance?: FhevmInstance;
}

/** Standardised result from any action handler */
export interface A2AResult {
  success: boolean;
  data?: any;
  error?: string;
}

// ============================================================================
// Contract ABIs (minimal, from marc-protocol-sdk)
// ============================================================================

/** ConfidentialUSDC token ABI */
export const TOKEN_ABI = [
  "function name() external view returns (string)",
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
  "function confidentialTotalSupply() external view returns (bytes32)",
  "function confidentialBalanceOf(address account) external view returns (bytes32)",
  "function confidentialTransfer(address to, bytes32 encryptedAmount, bytes calldata inputProof) external returns (bytes32)",
  "function setOperator(address operator, uint48 until) external",
  "function isOperator(address holder, address spender) external view returns (bool)",
  "function wrap(address to, uint256 amount) external",
  "function unwrap(address from, address to, bytes32 encryptedAmount, bytes calldata inputProof) external",
  "function finalizeUnwrap(bytes32 burntAmount, uint64 burntAmountCleartext, bytes calldata decryptionProof) external",
  "function underlying() external view returns (address)",
  "function rate() external view returns (uint256)",
  "function treasury() external view returns (address)",
  "function paused() external view returns (bool)",
] as const;

/** X402PaymentVerifier ABI */
export const VERIFIER_ABI = [
  "function recordPayment(address server, bytes32 nonce, uint64 minPrice) external",
  "function usedNonces(bytes32 nonce) external view returns (bool)",
  "function trustedToken() external view returns (address)",
  "event PaymentVerified(address indexed payer, address indexed server, bytes32 indexed nonce, uint64 minPrice)",
  "function payAndRecord(address token, address server, bytes32 nonce, uint64 minPrice, bytes32 encryptedAmount, bytes calldata inputProof) external",
  "event PayAndRecordCompleted(address indexed payer, address indexed server, bytes32 indexed nonce, address token, uint64 minPrice)",
  "function recordBatchPayment(address server, bytes32 nonce, uint32 requestCount, uint64 pricePerRequest) external",
  "event BatchPaymentRecorded(address indexed payer, address indexed server, bytes32 indexed nonce, uint32 requestCount, uint64 pricePerRequest)",
] as const;

/** USDC (underlying ERC-20) ABI — for approve/balanceOf */
export const USDC_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
] as const;

// ============================================================================
// Chain addresses
// ============================================================================

export interface MarcAddresses {
  /** ConfidentialUSDC (ERC-7984 token wrapper) */
  tokenAddress: string;
  /** X402PaymentVerifier (nonce registry) */
  verifierAddress: string;
  /** USDC (underlying ERC-20) */
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

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_HANDLE = "0x" + "00".repeat(32);
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function isValidAddress(addr: string): boolean {
  return ADDRESS_RE.test(addr);
}

function assertValidAddress(addr: string, label: string): void {
  if (!addr || addr === ZERO_ADDRESS || !isValidAddress(addr)) {
    throw new MarcA2AError(`Invalid ${label}: ${addr || "(empty)"}`);
  }
}

function assertPositiveAmount(amount: bigint, label: string): void {
  if (amount <= 0n) {
    throw new MarcA2AError(`${label} must be > 0, got ${amount}`);
  }
  if (amount > BigInt("0xFFFFFFFFFFFFFFFF")) {
    throw new MarcA2AError(`${label} exceeds uint64 max`);
  }
}

function assertFhevmInstance(ctx: A2AContext): asserts ctx is A2AContext & { fhevmInstance: FhevmInstance } {
  if (!ctx.fhevmInstance) {
    throw new MarcA2AError("fhevmInstance is required in context for this action");
  }
}

// ============================================================================
// Error
// ============================================================================

export class MarcA2AError extends Error {
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MarcA2AError";
    this.details = details;
  }
}

// ============================================================================
// Contract factory (dynamic import to avoid bundling ethers at module level)
// ============================================================================

async function createContract(address: string, abi: readonly string[], signer: Signer): Promise<any> {
  const { Contract } = await import("ethers");
  return new Contract(address, abi as string[], signer as any);
}

async function randomNonce(): Promise<string> {
  const { ethers } = await import("ethers");
  return ethers.hexlify(ethers.randomBytes(32));
}

// ============================================================================
// JSON Schema definitions for each action
// ============================================================================

const wrapInputSchema = {
  type: "object",
  required: ["amount"],
  properties: {
    amount: {
      type: "string",
      description: "Amount of USDC in raw units (6 decimals). 1000000 = 1 USDC.",
    },
    to: {
      type: "string",
      description: "Recipient address for the wrapped cUSDC. Defaults to signer address.",
    },
    tokenAddress: {
      type: "string",
      description: "ConfidentialUSDC contract address. Defaults to Sepolia deployment.",
    },
    usdcAddress: {
      type: "string",
      description: "Underlying USDC ERC-20 address. Defaults to Sepolia deployment.",
    },
  },
};

const unwrapInputSchema = {
  type: "object",
  required: ["amount"],
  properties: {
    amount: {
      type: "string",
      description: "Amount of cUSDC in raw units (6 decimals) to unwrap.",
    },
    from: {
      type: "string",
      description: "Address to unwrap from. Defaults to signer address.",
    },
    tokenAddress: {
      type: "string",
      description: "ConfidentialUSDC contract address. Defaults to Sepolia deployment.",
    },
  },
};

const transferInputSchema = {
  type: "object",
  required: ["to", "amount"],
  properties: {
    to: {
      type: "string",
      description: "Recipient address for the confidential transfer.",
    },
    amount: {
      type: "string",
      description: "Amount of cUSDC in raw units (6 decimals).",
    },
    tokenAddress: {
      type: "string",
      description: "ConfidentialUSDC contract address. Defaults to Sepolia deployment.",
    },
  },
};

const balanceInputSchema = {
  type: "object",
  properties: {
    address: {
      type: "string",
      description: "Address to check. Defaults to signer address.",
    },
    tokenAddress: {
      type: "string",
      description: "ConfidentialUSDC contract address. Defaults to Sepolia deployment.",
    },
  },
};

const payInputSchema = {
  type: "object",
  required: ["server", "amount"],
  properties: {
    server: {
      type: "string",
      description: "Server (recipient) address for the x402 payment.",
    },
    amount: {
      type: "string",
      description: "Payment amount in raw USDC units (6 decimals).",
    },
    tokenAddress: {
      type: "string",
      description: "ConfidentialUSDC contract address. Defaults to Sepolia deployment.",
    },
    verifierAddress: {
      type: "string",
      description: "X402PaymentVerifier contract address. Defaults to Sepolia deployment.",
    },
  },
};

// ============================================================================
// Action handlers
// ============================================================================

/**
 * Wrap plaintext USDC into ConfidentialUSDC (ERC-7984).
 * Approves USDC spending and calls token.wrap().
 */
export async function handleWrap(params: any, context: A2AContext): Promise<A2AResult> {
  try {
    const amount = BigInt(params.amount);
    const tokenAddress = params.tokenAddress || MARC_SEPOLIA_ADDRESSES.tokenAddress;
    const usdcAddress = params.usdcAddress || MARC_SEPOLIA_ADDRESSES.usdcAddress;

    assertPositiveAmount(amount, "amount");
    assertValidAddress(tokenAddress, "tokenAddress");
    assertValidAddress(usdcAddress, "usdcAddress");

    const signerAddress = await context.signer.getAddress();
    const to = params.to || signerAddress;
    assertValidAddress(to, "to");

    // Approve USDC spending
    const usdc = await createContract(usdcAddress, USDC_ABI as unknown as string[], context.signer);
    const approveTx = await usdc.approve(tokenAddress, amount);
    await approveTx.wait();

    // Wrap USDC -> cUSDC
    const token = await createContract(tokenAddress, TOKEN_ABI as unknown as string[], context.signer);
    const tx = await token.wrap(to, amount);
    const receipt = await tx.wait();

    if (!receipt || receipt.status === 0) {
      return { success: false, error: "Wrap transaction reverted" };
    }

    return {
      success: true,
      data: {
        action: "wrap",
        txHash: receipt.hash,
        amount: amount.toString(),
        to,
        blockNumber: receipt.blockNumber,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Wrap failed" };
  }
}

/**
 * Initiate encrypted unwrap of cUSDC back to USDC (step 1 of 2).
 * Requires fhevmInstance in context for FHE encryption.
 */
export async function handleUnwrap(params: any, context: A2AContext): Promise<A2AResult> {
  try {
    assertFhevmInstance(context);

    const amount = BigInt(params.amount);
    const tokenAddress = params.tokenAddress || MARC_SEPOLIA_ADDRESSES.tokenAddress;

    assertPositiveAmount(amount, "amount");
    assertValidAddress(tokenAddress, "tokenAddress");

    const signerAddress = await context.signer.getAddress();
    const from = params.from || signerAddress;
    assertValidAddress(from, "from");

    // Encrypt the unwrap amount
    const encInput = context.fhevmInstance.createEncryptedInput(tokenAddress, signerAddress);
    encInput.add64(amount);
    const encrypted = await encInput.encrypt();

    if (!encrypted.handles || encrypted.handles.length === 0) {
      return { success: false, error: "FHE encryption returned no handles" };
    }

    const token = await createContract(tokenAddress, TOKEN_ABI as unknown as string[], context.signer);
    const tx = await token.unwrap(from, signerAddress, encrypted.handles[0], encrypted.inputProof);
    const receipt = await tx.wait();

    if (!receipt || receipt.status === 0) {
      return { success: false, error: "Unwrap transaction reverted" };
    }

    return {
      success: true,
      data: {
        action: "unwrap_requested",
        txHash: receipt.hash,
        amount: amount.toString(),
        from,
        blockNumber: receipt.blockNumber,
        note: "Step 1 complete. After KMS processes the decryption, call finalizeUnwrap() on the token contract.",
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Unwrap failed" };
  }
}

/**
 * Send encrypted cUSDC to another address using FHE.
 * Requires fhevmInstance in context for FHE encryption.
 */
export async function handleTransfer(params: any, context: A2AContext): Promise<A2AResult> {
  try {
    assertFhevmInstance(context);

    const to = params.to;
    const amount = BigInt(params.amount);
    const tokenAddress = params.tokenAddress || MARC_SEPOLIA_ADDRESSES.tokenAddress;

    assertPositiveAmount(amount, "amount");
    assertValidAddress(to, "to");
    assertValidAddress(tokenAddress, "tokenAddress");

    const signerAddress = await context.signer.getAddress();

    // Encrypt amount
    const encInput = context.fhevmInstance.createEncryptedInput(tokenAddress, signerAddress);
    encInput.add64(amount);
    const encrypted = await encInput.encrypt();

    if (!encrypted.handles || encrypted.handles.length === 0) {
      return { success: false, error: "FHE encryption returned no handles" };
    }

    const token = await createContract(tokenAddress, TOKEN_ABI as unknown as string[], context.signer);
    const tx = await token.confidentialTransfer(to, encrypted.handles[0], encrypted.inputProof);
    const receipt = await tx.wait();

    if (!receipt || receipt.status === 0) {
      return { success: false, error: "Confidential transfer reverted" };
    }

    return {
      success: true,
      data: {
        action: "confidential_transfer",
        txHash: receipt.hash,
        to,
        encryptedHandle: encrypted.handles[0],
        blockNumber: receipt.blockNumber,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Transfer failed" };
  }
}

/**
 * Query the encrypted cUSDC balance handle for an address.
 * The returned handle is an FHE ciphertext reference — actual plaintext
 * balance can only be decrypted via the Zama KMS.
 */
export async function handleBalance(params: any, context: A2AContext): Promise<A2AResult> {
  try {
    const tokenAddress = params.tokenAddress || MARC_SEPOLIA_ADDRESSES.tokenAddress;
    assertValidAddress(tokenAddress, "tokenAddress");

    const signerAddress = await context.signer.getAddress();
    const address = params.address || signerAddress;
    assertValidAddress(address, "address");

    const token = await createContract(tokenAddress, TOKEN_ABI as unknown as string[], context.signer);

    let handle: string = ZERO_HANDLE;
    try {
      handle = await token.confidentialBalanceOf(address);
    } catch {
      // confidentialBalanceOf may fail on mock/local networks
    }

    const hasBalance = handle !== ZERO_HANDLE;

    return {
      success: true,
      data: {
        action: "balance",
        address,
        encryptedBalanceHandle: handle,
        hasEncryptedBalance: hasBalance,
        note: hasBalance
          ? "Non-zero encrypted balance detected. Decrypting requires KMS access."
          : "Zero balance handle — no cUSDC received at this address.",
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Balance check failed" };
  }
}

/**
 * Perform an x402 FHE payment: confidentialTransfer + recordPayment on the verifier.
 * Combines transfer and nonce recording into a single A2A action.
 */
export async function handlePay(params: any, context: A2AContext): Promise<A2AResult> {
  try {
    assertFhevmInstance(context);

    const server = params.server;
    const amount = BigInt(params.amount);
    const tokenAddress = params.tokenAddress || MARC_SEPOLIA_ADDRESSES.tokenAddress;
    const verifierAddress = params.verifierAddress || MARC_SEPOLIA_ADDRESSES.verifierAddress;

    assertValidAddress(server, "server");
    assertPositiveAmount(amount, "amount");
    assertValidAddress(tokenAddress, "tokenAddress");
    assertValidAddress(verifierAddress, "verifierAddress");

    const signerAddress = await context.signer.getAddress();
    const nonce = await randomNonce();

    // Step 1: Encrypt and transfer cUSDC to server
    const encInput = context.fhevmInstance.createEncryptedInput(tokenAddress, signerAddress);
    encInput.add64(amount);
    const encrypted = await encInput.encrypt();

    if (!encrypted.handles || encrypted.handles.length === 0) {
      return { success: false, error: "FHE encryption returned no handles" };
    }

    const token = await createContract(tokenAddress, TOKEN_ABI as unknown as string[], context.signer);
    const transferTx = await token.confidentialTransfer(server, encrypted.handles[0], encrypted.inputProof);
    const transferReceipt = await transferTx.wait();

    if (!transferReceipt || transferReceipt.status === 0) {
      return { success: false, error: "Payment transfer reverted" };
    }

    // Step 2: Record payment nonce on verifier
    const verifier = await createContract(verifierAddress, VERIFIER_ABI as unknown as string[], context.signer);
    const verifierTx = await verifier.recordPayment(server, nonce, amount);
    const verifierReceipt = await verifierTx.wait();

    if (!verifierReceipt || verifierReceipt.status === 0) {
      return {
        success: false,
        error: "Verifier recordPayment failed. Transfer succeeded — retry with a new nonce.",
        data: { transferTxHash: transferReceipt.hash },
      };
    }

    return {
      success: true,
      data: {
        action: "x402_payment",
        transferTxHash: transferReceipt.hash,
        verifierTxHash: verifierReceipt.hash,
        nonce,
        server,
        amount: amount.toString(),
        blockNumber: verifierReceipt.blockNumber,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Pay failed" };
  }
}

// ============================================================================
// MarcA2ASkill class
// ============================================================================

/**
 * MARC Protocol A2A Skill for Google's Agent-to-Agent protocol.
 *
 * Registers five FHE payment actions that any A2A-compatible agent can
 * discover and invoke:
 *
 * - marc_wrap:     Wrap plaintext USDC to ConfidentialUSDC (ERC-7984)
 * - marc_unwrap:   Initiate encrypted unwrap (step 1 of 2)
 * - marc_transfer: Send encrypted cUSDC to another address
 * - marc_balance:  Query encrypted balance handle
 * - marc_pay:      Full x402 payment (transfer + nonce recording)
 */
export class MarcA2ASkill {
  readonly id = "marc-protocol-fhe-payments";
  readonly name = "MARC Protocol FHE Payments";
  readonly description =
    "Provides FHE-encrypted USDC operations (wrap, unwrap, transfer, balance, pay) " +
    "using MARC Protocol on Ethereum. All amounts are encrypted on-chain via Zama fhEVM.";

  private actions: A2AAction[];

  constructor() {
    this.actions = [
      {
        name: "marc_wrap",
        description:
          "Wrap plaintext USDC into ConfidentialUSDC (ERC-7984). " +
          "Approves USDC spending and mints encrypted cUSDC tokens.",
        inputSchema: wrapInputSchema,
        handler: handleWrap,
      },
      {
        name: "marc_unwrap",
        description:
          "Initiate an encrypted unwrap of cUSDC back to plaintext USDC. " +
          "This is step 1 of 2; KMS finalization is required to complete the unwrap.",
        inputSchema: unwrapInputSchema,
        handler: handleUnwrap,
      },
      {
        name: "marc_transfer",
        description:
          "Send encrypted cUSDC to another address using FHE. " +
          "The transfer amount is encrypted on-chain — only sender and recipient can decrypt.",
        inputSchema: transferInputSchema,
        handler: handleTransfer,
      },
      {
        name: "marc_balance",
        description:
          "Query the encrypted cUSDC balance handle for an address. " +
          "Returns an FHE ciphertext reference; actual balance requires KMS decryption.",
        inputSchema: balanceInputSchema,
        handler: handleBalance,
      },
      {
        name: "marc_pay",
        description:
          "Perform a full x402 FHE payment: encrypted cUSDC transfer to a server " +
          "address followed by nonce recording on the X402PaymentVerifier contract.",
        inputSchema: payInputSchema,
        handler: handlePay,
      },
    ];
  }

  /** Return the A2A skill descriptor for agent discovery */
  getSkillDescriptor(): A2ASkill {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      actions: this.actions,
    };
  }

  /** Get a specific action by name */
  getAction(name: string): A2AAction | undefined {
    return this.actions.find((a) => a.name === name);
  }

  /** List all available action names */
  listActions(): string[] {
    return this.actions.map((a) => a.name);
  }

  /**
   * Execute an action by name.
   *
   * @param actionName - One of: marc_wrap, marc_unwrap, marc_transfer, marc_balance, marc_pay
   * @param params - Action-specific parameters (validated against inputSchema)
   * @param context - Runtime context with signer and optional fhevmInstance
   * @returns A2AResult with success/failure and data
   */
  async executeAction(actionName: string, params: any, context: A2AContext): Promise<A2AResult> {
    const action = this.getAction(actionName);
    if (!action) {
      return {
        success: false,
        error: `Unknown action: ${actionName}. Available: ${this.listActions().join(", ")}`,
      };
    }
    return action.handler(params, context);
  }

  /**
   * Validate params against an action's input schema (basic required-field check).
   * Returns an array of validation error messages, or empty array if valid.
   */
  validateParams(actionName: string, params: any): string[] {
    const action = this.getAction(actionName);
    if (!action) {
      return [`Unknown action: ${actionName}`];
    }

    const errors: string[] = [];
    const schema = action.inputSchema;

    if (!params || typeof params !== "object") {
      errors.push("params must be a non-null object");
      return errors;
    }

    if (schema.required) {
      for (const field of schema.required) {
        if (params[field] === undefined || params[field] === null || params[field] === "") {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }

    // Validate address fields if provided
    const addressFields = ["to", "from", "address", "server", "tokenAddress", "usdcAddress", "verifierAddress"];
    for (const field of addressFields) {
      if (params[field] && typeof params[field] === "string" && params[field] !== "") {
        if (!isValidAddress(params[field])) {
          errors.push(`Invalid address for ${field}: ${params[field]}`);
        }
      }
    }

    // Validate amount is a parseable BigInt string
    if (params.amount !== undefined) {
      try {
        const amt = BigInt(params.amount);
        if (amt <= 0n) {
          errors.push("amount must be > 0");
        }
      } catch {
        errors.push(`amount is not a valid integer string: ${params.amount}`);
      }
    }

    return errors;
  }
}
