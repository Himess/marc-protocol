// SPDX-License-Identifier: BUSL-1.1

/**
 * MARC Protocol — Coinbase AgentKit FHE Action Provider
 *
 * Provides FHE confidential payment actions for Coinbase AgentKit agents.
 * Each action wraps a MARC Protocol operation (wrap, unwrap, transfer,
 * balance check, x402 payment, nonce recording) behind a simple method
 * that accepts an ethers Signer and a Zama FhevmInstance.
 *
 * Usage with AgentKit:
 *
 *   import { MarcFheProvider, MARC_SEPOLIA_ADDRESSES } from "@marc-protocol/agentkit";
 *
 *   const provider = new MarcFheProvider();
 *   const result = await provider.wrapUsdc(signer, fhevmInstance, {
 *     amount: 1_000_000n,       // 1 USDC
 *     tokenAddress: MARC_SEPOLIA_ADDRESSES.tokenAddress,
 *     usdcAddress: MARC_SEPOLIA_ADDRESSES.usdcAddress,
 *   });
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
// Contract ABIs (minimal, from marc-protocol-sdk)
// ============================================================================

/** ConfidentialUSDC token ABI */
export const TOKEN_ABI = [
  // ERC-7984 inherited
  "function name() external view returns (string)",
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
  "function confidentialTotalSupply() external view returns (bytes32)",
  "function confidentialBalanceOf(address account) external view returns (bytes32)",
  "function confidentialTransfer(address to, bytes32 encryptedAmount, bytes calldata inputProof) external returns (bytes32)",
  "function setOperator(address operator, uint48 until) external",
  "function isOperator(address holder, address spender) external view returns (bool)",
  // ERC7984ERC20Wrapper inherited
  "function wrap(address to, uint256 amount) external",
  "function unwrap(address from, address to, bytes32 encryptedAmount, bytes calldata inputProof) external",
  "function finalizeUnwrap(bytes32 burntAmount, uint64 burntAmountCleartext, bytes calldata decryptionProof) external",
  "function underlying() external view returns (address)",
  "function rate() external view returns (uint256)",
  // ConfidentialUSDC specific
  "function treasury() external view returns (address)",
  "function paused() external view returns (bool)",
] as const;

/** X402PaymentVerifier ABI */
export const VERIFIER_ABI = [
  // V4.0
  "function recordPayment(address server, bytes32 nonce, uint64 minPrice) external",
  "function usedNonces(bytes32 nonce) external view returns (bool)",
  "function trustedToken() external view returns (address)",
  "event PaymentVerified(address indexed payer, address indexed server, bytes32 indexed nonce, uint64 minPrice)",
  // V4.2 — single-TX
  "function payAndRecord(address token, address server, bytes32 nonce, uint64 minPrice, bytes32 encryptedAmount, bytes calldata inputProof) external",
  "event PayAndRecordCompleted(address indexed payer, address indexed server, bytes32 indexed nonce, address token, uint64 minPrice)",
  // V4.3 — batch prepayment
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

/** Mainnet addresses — set after deployment */
export const MARC_MAINNET_ADDRESSES: MarcAddresses = {
  tokenAddress: "",
  verifierAddress: "",
  usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
};

// ============================================================================
// Configuration
// ============================================================================

export interface MarcConfig {
  /** Chain ID (default: 11155111 for Sepolia) */
  chainId?: number;
  /** JSON-RPC URL for on-chain reads (optional — only needed for getConfidentialBalance) */
  rpcUrl?: string;
}

// ============================================================================
// Result types
// ============================================================================

export interface WrapResult {
  action: "wrap";
  txHash: string;
  amount: string;
  to: string;
  blockNumber?: number;
}

export interface UnwrapResult {
  action: "unwrap_requested";
  txHash: string;
  amount: string;
  from: string;
  blockNumber?: number;
  note: string;
}

export interface TransferResult {
  action: "confidential_transfer";
  txHash: string;
  to: string;
  encryptedHandle: string;
  blockNumber?: number;
}

export interface BalanceResult {
  action: "balance";
  address: string;
  encryptedBalanceHandle: string;
  hasEncryptedBalance: boolean;
  note: string;
}

export interface X402PaymentResult {
  action: "x402_payment";
  transferTxHash: string;
  verifierTxHash: string;
  nonce: string;
  paymentHeader: string;
  resourceUrl: string;
  resourceResponse?: {
    status: number;
    statusText: string;
  };
}

export interface RecordPaymentResult {
  action: "record_payment";
  txHash: string;
  server: string;
  nonce: string;
  minPrice: string;
  blockNumber?: number;
}

// ============================================================================
// Input types
// ============================================================================

export interface WrapInput {
  /** Amount of USDC in raw units (6 decimals). 1_000_000 = 1 USDC. */
  amount: bigint;
  /** Recipient address for the wrapped cUSDC (defaults to signer address) */
  to?: string;
  /** ConfidentialUSDC contract address */
  tokenAddress: string;
  /** Underlying USDC ERC-20 address */
  usdcAddress: string;
}

export interface UnwrapInput {
  /** Amount of cUSDC in raw units (6 decimals) to unwrap */
  amount: bigint;
  /** Address to unwrap from (defaults to signer address) */
  from?: string;
  /** ConfidentialUSDC contract address */
  tokenAddress: string;
}

export interface TransferInput {
  /** Recipient address */
  to: string;
  /** Amount of cUSDC in raw units (6 decimals) */
  amount: bigint;
  /** ConfidentialUSDC contract address */
  tokenAddress: string;
}

export interface BalanceInput {
  /** Address to check (defaults to signer address) */
  address?: string;
  /** ConfidentialUSDC contract address */
  tokenAddress: string;
}

export interface X402PaymentInput {
  /** URL of the x402-protected resource */
  url: string;
  /** ConfidentialUSDC contract address */
  tokenAddress: string;
  /** X402PaymentVerifier contract address */
  verifierAddress: string;
  /** Maximum payment in raw USDC units (optional safety cap) */
  maxPayment?: bigint;
  /** Allowed network identifiers (CAIP-2) */
  allowedNetworks?: string[];
}

export interface RecordPaymentInput {
  /** Server (recipient) address */
  server: string;
  /** Unique nonce (bytes32 hex) */
  nonce: string;
  /** Minimum price in raw USDC units (6 decimals) */
  minPrice: bigint;
  /** X402PaymentVerifier contract address */
  verifierAddress: string;
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
    throw new MarcProviderError(`Invalid ${label}: ${addr || "(empty)"}`);
  }
}

function assertPositiveAmount(amount: bigint, label: string): void {
  if (amount <= 0n) {
    throw new MarcProviderError(`${label} must be > 0, got ${amount}`);
  }
  if (amount > BigInt("0xFFFFFFFFFFFFFFFF")) {
    throw new MarcProviderError(`${label} exceeds uint64 max`);
  }
}

/** Build canonical message for EIP-191 signing (sorted keys, no signature field) */
function canonicalMessage(data: Record<string, unknown>): string {
  const sorted = Object.keys(data)
    .filter((k) => k !== "signature")
    .sort()
    .reduce((obj, key) => ({ ...obj, [key]: data[key] }), {});
  return JSON.stringify(sorted);
}

// ============================================================================
// Error
// ============================================================================

export class MarcProviderError extends Error {
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MarcProviderError";
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
// MarcFheProvider
// ============================================================================

/**
 * MARC Protocol FHE Action Provider for Coinbase AgentKit.
 *
 * Provides six core actions for FHE-encrypted USDC operations:
 * - wrapUsdc:              Approve + wrap plaintext USDC to cUSDC (ERC-7984)
 * - unwrapCusdc:           Initiate encrypted unwrap (step 1 of 2; KMS finalization needed)
 * - confidentialTransfer:  Send encrypted cUSDC to another address
 * - getConfidentialBalance: Query encrypted balance handle
 * - payX402Resource:       Full x402 payment flow (fetch, pay, retry)
 * - recordPayment:         Record a payment nonce on-chain
 *
 * All methods accept an ethers Signer and a Zama FhevmInstance.
 * Contract instantiation uses dynamic import to keep the module lightweight.
 */
export class MarcFheProvider {
  private config: MarcConfig;

  constructor(config: MarcConfig = {}) {
    this.config = {
      chainId: config.chainId ?? 11155111,
      rpcUrl: config.rpcUrl,
    };
  }

  // ==========================================================================
  // 1. wrapUsdc — Approve + wrap USDC to cUSDC
  // ==========================================================================

  /**
   * Approve USDC spending and wrap into ConfidentialUSDC (ERC-7984).
   *
   * Flow:
   * 1. Approve the cUSDC contract to spend `amount` USDC
   * 2. Call cUSDC.wrap(to, amount) to mint encrypted cUSDC
   *
   * @param signer - Ethers signer with USDC balance
   * @param _fhevmInstance - Not used for wrap (plaintext operation), included for API consistency
   * @param input - Wrap parameters
   * @returns WrapResult with tx hash and amount
   */
  async wrapUsdc(signer: Signer, _fhevmInstance: FhevmInstance, input: WrapInput): Promise<WrapResult> {
    assertPositiveAmount(input.amount, "amount");
    assertValidAddress(input.tokenAddress, "tokenAddress");
    assertValidAddress(input.usdcAddress, "usdcAddress");

    const signerAddress = await signer.getAddress();
    const to = input.to ?? signerAddress;
    assertValidAddress(to, "to");

    // Approve USDC spending
    const usdc = await createContract(input.usdcAddress, USDC_ABI as unknown as string[], signer);
    const approveTx = await usdc.approve(input.tokenAddress, input.amount);
    await approveTx.wait();

    // Wrap USDC -> cUSDC
    const token = await createContract(input.tokenAddress, TOKEN_ABI as unknown as string[], signer);
    const tx = await token.wrap(to, input.amount);
    const receipt = await tx.wait();

    if (!receipt || receipt.status === 0) {
      throw new MarcProviderError("Wrap transaction reverted", { txHash: tx.hash });
    }

    return {
      action: "wrap",
      txHash: receipt.hash,
      amount: input.amount.toString(),
      to,
      blockNumber: receipt.blockNumber,
    };
  }

  // ==========================================================================
  // 2. unwrapCusdc — Initiate cUSDC unwrap (step 1 of 2)
  // ==========================================================================

  /**
   * Initiate an encrypted unwrap of cUSDC back to USDC.
   *
   * This is step 1 of 2. After the Zama KMS processes the decryption,
   * call finalizeUnwrap() on the token contract to complete step 2.
   *
   * @param signer - Ethers signer holding cUSDC
   * @param fhevmInstance - Zama FhevmInstance for encryption
   * @param input - Unwrap parameters
   * @returns UnwrapResult with tx hash
   */
  async unwrapCusdc(signer: Signer, fhevmInstance: FhevmInstance, input: UnwrapInput): Promise<UnwrapResult> {
    assertPositiveAmount(input.amount, "amount");
    assertValidAddress(input.tokenAddress, "tokenAddress");

    const signerAddress = await signer.getAddress();
    const from = input.from ?? signerAddress;
    assertValidAddress(from, "from");

    // Encrypt the unwrap amount
    const encInput = fhevmInstance.createEncryptedInput(input.tokenAddress, signerAddress);
    encInput.add64(input.amount);
    const encrypted = await encInput.encrypt();

    if (!encrypted.handles || encrypted.handles.length === 0) {
      throw new MarcProviderError("FHE encryption returned no handles");
    }

    // Call unwrap(from, to, encryptedAmount, inputProof)
    const token = await createContract(input.tokenAddress, TOKEN_ABI as unknown as string[], signer);
    const tx = await token.unwrap(from, signerAddress, encrypted.handles[0], encrypted.inputProof);
    const receipt = await tx.wait();

    if (!receipt || receipt.status === 0) {
      throw new MarcProviderError("Unwrap transaction reverted", { txHash: tx.hash });
    }

    return {
      action: "unwrap_requested",
      txHash: receipt.hash,
      amount: input.amount.toString(),
      from,
      blockNumber: receipt.blockNumber,
      note: "Step 1 complete. After KMS processes the decryption, call finalizeUnwrap() on the token contract.",
    };
  }

  // ==========================================================================
  // 3. confidentialTransfer — Send encrypted cUSDC
  // ==========================================================================

  /**
   * Send encrypted cUSDC to another address using FHE.
   *
   * The transfer amount is encrypted on-chain — only the sender and
   * recipient (via KMS) can decrypt it. The transaction always succeeds
   * even if the sender has insufficient balance (FHE silent failure).
   *
   * @param signer - Ethers signer holding cUSDC
   * @param fhevmInstance - Zama FhevmInstance for encryption
   * @param input - Transfer parameters
   * @returns TransferResult with tx hash and encrypted handle
   */
  async confidentialTransfer(
    signer: Signer,
    fhevmInstance: FhevmInstance,
    input: TransferInput
  ): Promise<TransferResult> {
    assertPositiveAmount(input.amount, "amount");
    assertValidAddress(input.to, "to");
    assertValidAddress(input.tokenAddress, "tokenAddress");

    const signerAddress = await signer.getAddress();

    // Encrypt amount
    const encInput = fhevmInstance.createEncryptedInput(input.tokenAddress, signerAddress);
    encInput.add64(input.amount);
    const encrypted = await encInput.encrypt();

    if (!encrypted.handles || encrypted.handles.length === 0) {
      throw new MarcProviderError("FHE encryption returned no handles");
    }

    // Call confidentialTransfer(to, encryptedAmount, inputProof)
    const token = await createContract(input.tokenAddress, TOKEN_ABI as unknown as string[], signer);
    const tx = await token.confidentialTransfer(input.to, encrypted.handles[0], encrypted.inputProof);
    const receipt = await tx.wait();

    if (!receipt || receipt.status === 0) {
      throw new MarcProviderError("Confidential transfer reverted", { txHash: tx.hash });
    }

    return {
      action: "confidential_transfer",
      txHash: receipt.hash,
      to: input.to,
      encryptedHandle: encrypted.handles[0],
      blockNumber: receipt.blockNumber,
    };
  }

  // ==========================================================================
  // 4. getConfidentialBalance — Query encrypted balance
  // ==========================================================================

  /**
   * Query the encrypted cUSDC balance handle for an address.
   *
   * The returned handle is an FHE ciphertext reference. The actual
   * plaintext balance can only be decrypted via the Zama KMS by the
   * balance holder.
   *
   * @param signer - Ethers signer (used for contract instantiation)
   * @param _fhevmInstance - Not used for reads, included for API consistency
   * @param input - Balance query parameters
   * @returns BalanceResult with encrypted handle
   */
  async getConfidentialBalance(
    signer: Signer,
    _fhevmInstance: FhevmInstance,
    input: BalanceInput
  ): Promise<BalanceResult> {
    assertValidAddress(input.tokenAddress, "tokenAddress");

    const signerAddress = await signer.getAddress();
    const address = input.address ?? signerAddress;
    assertValidAddress(address, "address");

    const token = await createContract(input.tokenAddress, TOKEN_ABI as unknown as string[], signer);

    let handle: string = ZERO_HANDLE;
    try {
      handle = await token.confidentialBalanceOf(address);
    } catch {
      // confidentialBalanceOf may fail on mock/local networks
    }

    const hasBalance = handle !== ZERO_HANDLE;

    return {
      action: "balance",
      address,
      encryptedBalanceHandle: handle,
      hasEncryptedBalance: hasBalance,
      note: hasBalance
        ? "Non-zero encrypted balance detected. Decrypting requires KMS access."
        : "Zero balance handle — no cUSDC received at this address.",
    };
  }

  // ==========================================================================
  // 5. payX402Resource — Full x402 payment flow
  // ==========================================================================

  /**
   * Perform a full x402 payment flow against a protected resource.
   *
   * Flow:
   * 1. Fetch the URL — expect a 402 response with payment requirements
   * 2. Parse requirements, validate scheme and price
   * 3. Encrypt amount with FHE and call confidentialTransfer
   * 4. Record nonce via verifier.recordPayment
   * 5. Build Payment header and retry the request
   *
   * @param signer - Ethers signer with cUSDC balance
   * @param fhevmInstance - Zama FhevmInstance for encryption
   * @param input - Payment parameters
   * @returns X402PaymentResult with tx hashes and payment header
   */
  async payX402Resource(
    signer: Signer,
    fhevmInstance: FhevmInstance,
    input: X402PaymentInput
  ): Promise<X402PaymentResult> {
    if (!input.url) {
      throw new MarcProviderError("URL is required");
    }
    assertValidAddress(input.tokenAddress, "tokenAddress");
    assertValidAddress(input.verifierAddress, "verifierAddress");

    // Step 1: Fetch the resource
    const response = await fetch(input.url);
    if (response.status !== 402) {
      throw new MarcProviderError("Resource did not return 402", {
        status: response.status,
        url: input.url,
      });
    }

    // Step 2: Parse 402 body
    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new MarcProviderError("Failed to parse 402 response body", { url: input.url });
    }

    if (!body || body.x402Version !== 1 || !Array.isArray(body.accepts)) {
      throw new MarcProviderError("Invalid 402 response format", { body });
    }

    // Select matching requirement
    const requirement = body.accepts.find((r: any) => {
      if (r.scheme !== FHE_SCHEME) return false;
      if (input.allowedNetworks?.length && !input.allowedNetworks.includes(r.network)) return false;
      if (input.maxPayment && input.maxPayment > 0n && BigInt(r.price) > input.maxPayment) return false;
      return true;
    });

    if (!requirement) {
      throw new MarcProviderError("No matching payment requirement found", {
        schemes: body.accepts.map((r: any) => r.scheme),
        url: input.url,
      });
    }

    const amount = BigInt(requirement.price);
    const signerAddress = await signer.getAddress();
    const nonce = await randomNonce();

    // Step 3: Encrypt and transfer
    const encInput = fhevmInstance.createEncryptedInput(input.tokenAddress, signerAddress);
    encInput.add64(amount);
    const encrypted = await encInput.encrypt();

    if (!encrypted.handles || encrypted.handles.length === 0) {
      throw new MarcProviderError("FHE encryption returned no handles");
    }

    const token = await createContract(input.tokenAddress, TOKEN_ABI as unknown as string[], signer);
    const transferTx = await token.confidentialTransfer(
      requirement.recipientAddress,
      encrypted.handles[0],
      encrypted.inputProof
    );
    const transferReceipt = await transferTx.wait();

    if (!transferReceipt || transferReceipt.status === 0) {
      throw new MarcProviderError("Payment transfer reverted", { txHash: transferTx.hash });
    }

    // Step 4: Record nonce
    const verifier = await createContract(input.verifierAddress, VERIFIER_ABI as unknown as string[], signer);
    let verifierTx: any;
    try {
      verifierTx = await verifier.recordPayment(requirement.recipientAddress, nonce, amount);
      const vReceipt = await verifierTx.wait();
      if (!vReceipt || vReceipt.status === 0) {
        throw new Error("Verifier TX reverted");
      }
    } catch (err) {
      throw new MarcProviderError(
        "Verifier recordPayment failed. Transfer succeeded — retry with a new nonce.",
        {
          transferTxHash: transferTx.hash,
          verifierTxHash: verifierTx?.hash,
          nonce,
        }
      );
    }

    // Step 5: Build payment header and retry
    const chainId = this.config.chainId ?? 11155111;
    const payloadData: Record<string, unknown> = {
      scheme: FHE_SCHEME,
      txHash: transferTx.hash,
      verifierTxHash: verifierTx.hash,
      nonce,
      from: signerAddress,
      chainId,
    };
    const signature = await signer.signMessage(canonicalMessage(payloadData));
    const payload = { ...payloadData, signature };
    const paymentHeader = Buffer.from(JSON.stringify(payload)).toString("base64");

    // Retry the request with Payment header
    let resourceResponse: { status: number; statusText: string } | undefined;
    try {
      const retryRes = await fetch(input.url, {
        headers: { Payment: paymentHeader },
      });
      resourceResponse = { status: retryRes.status, statusText: retryRes.statusText };
    } catch {
      // Retry failed but payment was made — return result anyway
    }

    return {
      action: "x402_payment",
      transferTxHash: transferTx.hash,
      verifierTxHash: verifierTx.hash,
      nonce,
      paymentHeader,
      resourceUrl: input.url,
      resourceResponse,
    };
  }

  // ==========================================================================
  // 6. recordPayment — Record nonce on-chain
  // ==========================================================================

  /**
   * Record a payment nonce on-chain via the X402PaymentVerifier.
   *
   * This is typically called after a confidentialTransfer to register
   * the payment nonce so the server can verify it.
   *
   * @param signer - Ethers signer (payer)
   * @param input - Record payment parameters
   * @returns RecordPaymentResult with tx hash
   */
  async recordPayment(signer: Signer, input: RecordPaymentInput): Promise<RecordPaymentResult> {
    assertValidAddress(input.server, "server");
    assertValidAddress(input.verifierAddress, "verifierAddress");
    assertPositiveAmount(input.minPrice, "minPrice");

    if (!input.nonce || !/^0x[a-fA-F0-9]{64}$/.test(input.nonce)) {
      throw new MarcProviderError("Invalid nonce — must be a 32-byte hex string (0x + 64 hex chars)", {
        nonce: input.nonce,
      });
    }

    const verifier = await createContract(input.verifierAddress, VERIFIER_ABI as unknown as string[], signer);

    const tx = await verifier.recordPayment(input.server, input.nonce, input.minPrice);
    const receipt = await tx.wait();

    if (!receipt || receipt.status === 0) {
      throw new MarcProviderError("recordPayment transaction reverted", { txHash: tx.hash });
    }

    return {
      action: "record_payment",
      txHash: receipt.hash,
      server: input.server,
      nonce: input.nonce,
      minPrice: input.minPrice.toString(),
      blockNumber: receipt.blockNumber,
    };
  }
}
