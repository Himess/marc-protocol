// SPDX-License-Identifier: BUSL-1.1

/**
 * MARC Protocol — CrewAI Tool Plugin
 *
 * Provides 5 CrewAI-compatible tools for FHE confidential USDC operations:
 * - MarcWrapCrewTool:     Wrap plaintext USDC into FHE-encrypted cUSDC (ERC-7984)
 * - MarcUnwrapCrewTool:   Initiate cUSDC unwrap back to plaintext USDC
 * - MarcTransferCrewTool: Send encrypted cUSDC to another address
 * - MarcBalanceCrewTool:  Query encrypted balance handle
 * - MarcPayCrewTool:      Full x402 payment flow (fetch 402, pay, verify, retry)
 *
 * Usage:
 *
 *   import { createMarcCrewTools, MARC_SEPOLIA_ADDRESSES } from "@marc-protocol/crewai-tool";
 *
 *   const tools = createMarcCrewTools(signer, fhevmInstance);
 *   // tools is an array of CrewAITool objects ready for a CrewAI agent
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
// CrewAI Tool interface
// ============================================================================

/**
 * CrewAI-compatible tool interface.
 *
 * CrewAI tools accept a dictionary of arguments and return a string result.
 * The args_schema describes the expected input shape for the agent.
 */
export interface CrewAITool {
  /** Tool name (snake_case, used by agent for selection) */
  name: string;
  /** Human-readable description — tells the agent when to use this tool */
  description: string;
  /** Schema describing the expected argument fields */
  args_schema: Record<string, any>;
  /** Execute the tool with parsed arguments, returns a string result */
  run: (args: Record<string, any>) => Promise<string>;
}

// ============================================================================
// Contract ABIs (minimal)
// ============================================================================

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

export const MARC_MAINNET_ADDRESSES: MarcAddresses = {
  tokenAddress: "",
  verifierAddress: "",
  usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
};

// ============================================================================
// Configuration
// ============================================================================

export interface MarcToolConfig {
  /** Chain ID (default: 11155111 for Sepolia) */
  chainId?: number;
  /** Override contract addresses (defaults to Sepolia) */
  addresses?: MarcAddresses;
}

// ============================================================================
// Internal helpers
// ============================================================================

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_HANDLE = "0x" + "00".repeat(32);
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const FHE_SCHEME = "fhe-confidential-v1";

function isValidAddress(addr: string): boolean {
  return ADDRESS_RE.test(addr);
}

function assertValidAddress(addr: string, label: string): void {
  if (!addr || addr === ZERO_ADDRESS || !isValidAddress(addr)) {
    throw new MarcToolError(`Invalid ${label}: ${addr || "(empty)"}`);
  }
}

function assertPositiveAmount(amount: bigint, label: string): void {
  if (amount <= 0n) {
    throw new MarcToolError(`${label} must be > 0, got ${amount}`);
  }
  if (amount > BigInt("0xFFFFFFFFFFFFFFFF")) {
    throw new MarcToolError(`${label} exceeds uint64 max`);
  }
}

function canonicalMessage(data: Record<string, unknown>): string {
  const sorted = Object.keys(data)
    .filter((k) => k !== "signature")
    .sort()
    .reduce((obj, key) => ({ ...obj, [key]: data[key] }), {});
  return JSON.stringify(sorted);
}

// ============================================================================
// Contract factory
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
// Error
// ============================================================================

export class MarcToolError extends Error {
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MarcToolError";
    this.details = details;
  }
}

// ============================================================================
// MarcWrapCrewTool
// ============================================================================

export class MarcWrapCrewTool implements CrewAITool {
  name = "marc_wrap";
  description =
    "Wrap plaintext USDC into FHE-encrypted confidential USDC (cUSDC). " +
    "Use this when you need to convert regular USDC into privacy-preserving cUSDC using the MARC Protocol. " +
    "Requires amount (in raw USDC units, 6 decimals — 1000000 = 1 USDC) and optionally a recipient address.";

  args_schema = {
    type: "object",
    properties: {
      amount: {
        type: "string",
        description: "Amount of USDC in raw units (6 decimals). 1000000 = 1 USDC.",
      },
      to: {
        type: "string",
        description: "Recipient address for wrapped cUSDC. Defaults to signer address if omitted.",
      },
    },
    required: ["amount"],
  };

  private signer: Signer;
  private fhevmInstance: FhevmInstance | undefined;
  private addresses: MarcAddresses;

  constructor(signer: Signer, fhevmInstance?: FhevmInstance, config?: MarcToolConfig) {
    this.signer = signer;
    this.fhevmInstance = fhevmInstance;
    this.addresses = config?.addresses ?? MARC_SEPOLIA_ADDRESSES;
  }

  async run(args: Record<string, any>): Promise<string> {
    const amount = BigInt(args.amount);
    assertPositiveAmount(amount, "amount");
    assertValidAddress(this.addresses.tokenAddress, "tokenAddress");
    assertValidAddress(this.addresses.usdcAddress, "usdcAddress");

    const signerAddress = await this.signer.getAddress();
    const to = (args.to as string) ?? signerAddress;
    assertValidAddress(to, "to");

    // Approve USDC spending
    const usdc = await createContract(this.addresses.usdcAddress, USDC_ABI as unknown as string[], this.signer);
    const approveTx = await usdc.approve(this.addresses.tokenAddress, amount);
    await approveTx.wait();

    // Wrap USDC -> cUSDC
    const token = await createContract(this.addresses.tokenAddress, TOKEN_ABI as unknown as string[], this.signer);
    const tx = await token.wrap(to, amount);
    const receipt = await tx.wait();

    if (!receipt || receipt.status === 0) {
      throw new MarcToolError("Wrap transaction reverted", { txHash: tx.hash });
    }

    return JSON.stringify({
      action: "wrap",
      txHash: receipt.hash,
      amount: amount.toString(),
      to,
      blockNumber: receipt.blockNumber,
    });
  }
}

// ============================================================================
// MarcUnwrapCrewTool
// ============================================================================

export class MarcUnwrapCrewTool implements CrewAITool {
  name = "marc_unwrap";
  description =
    "Initiate unwrapping of FHE-encrypted cUSDC back to plaintext USDC. " +
    "This is step 1 of 2 — after Zama KMS processes the decryption, finalizeUnwrap must be called. " +
    "Requires amount (in raw USDC units, 6 decimals). Requires FhevmInstance for encryption.";

  args_schema = {
    type: "object",
    properties: {
      amount: {
        type: "string",
        description: "Amount of cUSDC to unwrap in raw units (6 decimals). 1000000 = 1 USDC.",
      },
      from: {
        type: "string",
        description: "Address to unwrap from. Defaults to signer address if omitted.",
      },
    },
    required: ["amount"],
  };

  private signer: Signer;
  private fhevmInstance: FhevmInstance | undefined;
  private addresses: MarcAddresses;

  constructor(signer: Signer, fhevmInstance?: FhevmInstance, config?: MarcToolConfig) {
    this.signer = signer;
    this.fhevmInstance = fhevmInstance;
    this.addresses = config?.addresses ?? MARC_SEPOLIA_ADDRESSES;
  }

  async run(args: Record<string, any>): Promise<string> {
    if (!this.fhevmInstance) {
      throw new MarcToolError("FhevmInstance is required for unwrap operations");
    }

    const amount = BigInt(args.amount);
    assertPositiveAmount(amount, "amount");
    assertValidAddress(this.addresses.tokenAddress, "tokenAddress");

    const signerAddress = await this.signer.getAddress();
    const from = (args.from as string) ?? signerAddress;
    assertValidAddress(from, "from");

    // Encrypt the unwrap amount
    const encInput = this.fhevmInstance.createEncryptedInput(this.addresses.tokenAddress, signerAddress);
    encInput.add64(amount);
    const encrypted = await encInput.encrypt();

    if (!encrypted.handles || encrypted.handles.length === 0) {
      throw new MarcToolError("FHE encryption returned no handles");
    }

    const token = await createContract(this.addresses.tokenAddress, TOKEN_ABI as unknown as string[], this.signer);
    const tx = await token.unwrap(from, signerAddress, encrypted.handles[0], encrypted.inputProof);
    const receipt = await tx.wait();

    if (!receipt || receipt.status === 0) {
      throw new MarcToolError("Unwrap transaction reverted", { txHash: tx.hash });
    }

    return JSON.stringify({
      action: "unwrap_requested",
      txHash: receipt.hash,
      amount: amount.toString(),
      from,
      blockNumber: receipt.blockNumber,
      note: "Step 1 complete. After KMS processes the decryption, call finalizeUnwrap() on the token contract.",
    });
  }
}

// ============================================================================
// MarcTransferCrewTool
// ============================================================================

export class MarcTransferCrewTool implements CrewAITool {
  name = "marc_transfer";
  description =
    "Send FHE-encrypted confidential USDC (cUSDC) to another address. " +
    "The transfer amount is encrypted on-chain — only sender and recipient can see it. " +
    "Requires to (recipient address) and amount (raw USDC units, 6 decimals). Requires FhevmInstance.";

  args_schema = {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Recipient Ethereum address (0x-prefixed, 40 hex chars).",
      },
      amount: {
        type: "string",
        description: "Amount of cUSDC to transfer in raw units (6 decimals). 1000000 = 1 USDC.",
      },
    },
    required: ["to", "amount"],
  };

  private signer: Signer;
  private fhevmInstance: FhevmInstance | undefined;
  private addresses: MarcAddresses;

  constructor(signer: Signer, fhevmInstance?: FhevmInstance, config?: MarcToolConfig) {
    this.signer = signer;
    this.fhevmInstance = fhevmInstance;
    this.addresses = config?.addresses ?? MARC_SEPOLIA_ADDRESSES;
  }

  async run(args: Record<string, any>): Promise<string> {
    if (!this.fhevmInstance) {
      throw new MarcToolError("FhevmInstance is required for transfer operations");
    }

    const amount = BigInt(args.amount);
    assertPositiveAmount(amount, "amount");
    assertValidAddress(args.to as string, "to");
    assertValidAddress(this.addresses.tokenAddress, "tokenAddress");

    const signerAddress = await this.signer.getAddress();

    // Encrypt amount
    const encInput = this.fhevmInstance.createEncryptedInput(this.addresses.tokenAddress, signerAddress);
    encInput.add64(amount);
    const encrypted = await encInput.encrypt();

    if (!encrypted.handles || encrypted.handles.length === 0) {
      throw new MarcToolError("FHE encryption returned no handles");
    }

    const token = await createContract(this.addresses.tokenAddress, TOKEN_ABI as unknown as string[], this.signer);
    const tx = await token.confidentialTransfer(args.to, encrypted.handles[0], encrypted.inputProof);
    const receipt = await tx.wait();

    if (!receipt || receipt.status === 0) {
      throw new MarcToolError("Confidential transfer reverted", { txHash: tx.hash });
    }

    return JSON.stringify({
      action: "confidential_transfer",
      txHash: receipt.hash,
      to: args.to,
      encryptedHandle: encrypted.handles[0],
      blockNumber: receipt.blockNumber,
    });
  }
}

// ============================================================================
// MarcBalanceCrewTool
// ============================================================================

export class MarcBalanceCrewTool implements CrewAITool {
  name = "marc_balance";
  description =
    "Check the FHE-encrypted confidential USDC (cUSDC) balance of an address. " +
    "Returns an encrypted balance handle — actual value can only be decrypted by the balance holder via Zama KMS. " +
    "Optionally takes an address argument (defaults to signer address).";

  args_schema = {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "Ethereum address to check balance for. Defaults to signer address if omitted.",
      },
    },
    required: [],
  };

  private signer: Signer;
  private fhevmInstance: FhevmInstance | undefined;
  private addresses: MarcAddresses;

  constructor(signer: Signer, fhevmInstance?: FhevmInstance, config?: MarcToolConfig) {
    this.signer = signer;
    this.fhevmInstance = fhevmInstance;
    this.addresses = config?.addresses ?? MARC_SEPOLIA_ADDRESSES;
  }

  async run(args: Record<string, any>): Promise<string> {
    assertValidAddress(this.addresses.tokenAddress, "tokenAddress");

    const signerAddress = await this.signer.getAddress();
    const address = (args.address as string) ?? signerAddress;
    assertValidAddress(address, "address");

    const token = await createContract(this.addresses.tokenAddress, TOKEN_ABI as unknown as string[], this.signer);

    let handle: string = ZERO_HANDLE;
    try {
      handle = await token.confidentialBalanceOf(address);
    } catch {
      // confidentialBalanceOf may fail on mock/local networks
    }

    const hasBalance = handle !== ZERO_HANDLE;

    return JSON.stringify({
      action: "balance",
      address,
      encryptedBalanceHandle: handle,
      hasEncryptedBalance: hasBalance,
      note: hasBalance
        ? "Non-zero encrypted balance detected. Decrypting requires KMS access."
        : "Zero balance handle — no cUSDC received at this address.",
    });
  }
}

// ============================================================================
// MarcPayCrewTool
// ============================================================================

export class MarcPayCrewTool implements CrewAITool {
  name = "marc_pay";
  description =
    "Perform a full x402 confidential payment flow against a protected resource URL. " +
    "Fetches the URL, expects a 402 response with payment requirements, encrypts and transfers cUSDC, " +
    "records the nonce on-chain, then retries the request with a Payment header. " +
    "Requires url (the protected resource). Optionally maxPayment (safety cap in raw USDC units).";

  args_schema = {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL of the x402-protected resource to pay for.",
      },
      maxPayment: {
        type: "string",
        description: "Maximum payment in raw USDC units (optional safety cap). 1000000 = 1 USDC.",
      },
    },
    required: ["url"],
  };

  private signer: Signer;
  private fhevmInstance: FhevmInstance | undefined;
  private addresses: MarcAddresses;
  private chainId: number;

  constructor(signer: Signer, fhevmInstance?: FhevmInstance, config?: MarcToolConfig) {
    this.signer = signer;
    this.fhevmInstance = fhevmInstance;
    this.addresses = config?.addresses ?? MARC_SEPOLIA_ADDRESSES;
    this.chainId = config?.chainId ?? 11155111;
  }

  async run(args: Record<string, any>): Promise<string> {
    if (!this.fhevmInstance) {
      throw new MarcToolError("FhevmInstance is required for payment operations");
    }

    const url = args.url as string;
    if (!url) {
      throw new MarcToolError("URL is required");
    }
    assertValidAddress(this.addresses.tokenAddress, "tokenAddress");
    assertValidAddress(this.addresses.verifierAddress, "verifierAddress");

    // Step 1: Fetch the resource
    const response = await fetch(url);
    if (response.status !== 402) {
      throw new MarcToolError("Resource did not return 402", {
        status: response.status,
        url,
      });
    }

    // Step 2: Parse 402 body
    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new MarcToolError("Failed to parse 402 response body", { url });
    }

    if (!body || body.x402Version !== 1 || !Array.isArray(body.accepts)) {
      throw new MarcToolError("Invalid 402 response format", { body });
    }

    const maxPayment = args.maxPayment ? BigInt(args.maxPayment as string) : undefined;

    // Select matching requirement
    const requirement = body.accepts.find((r: any) => {
      if (r.scheme !== FHE_SCHEME) return false;
      if (maxPayment && maxPayment > 0n && BigInt(r.price) > maxPayment) return false;
      return true;
    });

    if (!requirement) {
      throw new MarcToolError("No matching payment requirement found", {
        schemes: body.accepts.map((r: any) => r.scheme),
        url,
      });
    }

    const amount = BigInt(requirement.price);
    const signerAddress = await this.signer.getAddress();
    const nonce = await randomNonce();

    // Step 3: Encrypt and transfer
    const encInput = this.fhevmInstance.createEncryptedInput(this.addresses.tokenAddress, signerAddress);
    encInput.add64(amount);
    const encrypted = await encInput.encrypt();

    if (!encrypted.handles || encrypted.handles.length === 0) {
      throw new MarcToolError("FHE encryption returned no handles");
    }

    const token = await createContract(this.addresses.tokenAddress, TOKEN_ABI as unknown as string[], this.signer);
    const transferTx = await token.confidentialTransfer(
      requirement.recipientAddress,
      encrypted.handles[0],
      encrypted.inputProof
    );
    const transferReceipt = await transferTx.wait();

    if (!transferReceipt || transferReceipt.status === 0) {
      throw new MarcToolError("Payment transfer reverted", { txHash: transferTx.hash });
    }

    // Step 4: Record nonce
    const verifier = await createContract(
      this.addresses.verifierAddress,
      VERIFIER_ABI as unknown as string[],
      this.signer
    );
    let verifierTx: any;
    try {
      verifierTx = await verifier.recordPayment(requirement.recipientAddress, nonce, amount);
      const vReceipt = await verifierTx.wait();
      if (!vReceipt || vReceipt.status === 0) {
        throw new Error("Verifier TX reverted");
      }
    } catch (err) {
      throw new MarcToolError("Verifier recordPayment failed. Transfer succeeded — retry with a new nonce.", {
        transferTxHash: transferTx.hash,
        verifierTxHash: verifierTx?.hash,
        nonce,
      });
    }

    // Step 5: Build payment header and retry
    const payloadData: Record<string, unknown> = {
      scheme: FHE_SCHEME,
      txHash: transferTx.hash,
      verifierTxHash: verifierTx.hash,
      nonce,
      from: signerAddress,
      chainId: this.chainId,
    };
    const signature = await this.signer.signMessage(canonicalMessage(payloadData));
    const payload = { ...payloadData, signature };
    const paymentHeader = Buffer.from(JSON.stringify(payload)).toString("base64");

    let resourceResponse: { status: number; statusText: string } | undefined;
    try {
      const retryRes = await fetch(url, {
        headers: { Payment: paymentHeader },
      });
      resourceResponse = { status: retryRes.status, statusText: retryRes.statusText };
    } catch {
      // Retry failed but payment was made
    }

    return JSON.stringify({
      action: "x402_payment",
      transferTxHash: transferTx.hash,
      verifierTxHash: verifierTx.hash,
      nonce,
      paymentHeader,
      resourceUrl: url,
      resourceResponse,
    });
  }
}

// ============================================================================
// Factory function
// ============================================================================

/**
 * Create all 5 MARC Protocol tools for CrewAI.
 *
 * @param signer - Ethers signer for on-chain transactions
 * @param fhevmInstance - Zama FhevmInstance for FHE encryption (optional — required for unwrap/transfer/pay)
 * @param config - Optional configuration (chainId, contract addresses)
 * @returns Array of CrewAITool objects
 */
export function createMarcCrewTools(
  signer: Signer,
  fhevmInstance?: FhevmInstance,
  config?: MarcToolConfig
): CrewAITool[] {
  return [
    new MarcWrapCrewTool(signer, fhevmInstance, config),
    new MarcUnwrapCrewTool(signer, fhevmInstance, config),
    new MarcTransferCrewTool(signer, fhevmInstance, config),
    new MarcBalanceCrewTool(signer, fhevmInstance, config),
    new MarcPayCrewTool(signer, fhevmInstance, config),
  ];
}
