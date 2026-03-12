import {
  GameWorker,
  GameFunction,
  ExecutableGameFunctionResponse,
  ExecutableGameFunctionStatus,
} from "@virtuals-protocol/game";
import { JsonRpcProvider, Wallet, Contract, ethers } from "ethers";
import { TOKEN_ABI, VERIFIER_ABI } from "fhe-x402-sdk";
import type { FhevmInstance } from "fhe-x402-sdk";

// ============================================================================
// Types
// ============================================================================

export interface IFhePluginOptions {
  id?: string;
  name?: string;
  description?: string;
  credentials: {
    privateKey: string;
    rpcUrl?: string;
    tokenAddress: string;
    verifierAddress: string;
    usdcAddress?: string;
    chainId?: number;
    /** Required: @zama-fhe/relayer-sdk instance for FHE encryption */
    fhevmInstance: FhevmInstance;
  };
}

const DEFAULT_USDC = "0xc89e913676B034f8b38E49f7508803d1cDEC9F4f";
const USDC_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
];

// ============================================================================
// Plugin
// ============================================================================

class FhePlugin {
  private id: string;
  private name: string;
  private description: string;
  private token: Contract | null = null;
  private verifier: Contract | null = null;
  private usdc: Contract | null = null;
  private signer: Wallet | null = null;
  private initPromise: Promise<void> | null = null;
  private credentials: IFhePluginOptions["credentials"];

  constructor(options: IFhePluginOptions) {
    this.id = options.id || "fhe_x402_worker";
    this.name = options.name || "FHE x402 Payment Worker";
    this.description =
      options.description ||
      "Manages encrypted USDC payments using FHE on Ethereum. Can wrap, pay, unwrap, and check status.";
    this.credentials = options.credentials;

    if (!this.credentials.privateKey) {
      throw new Error("Private key is required");
    }
    if (!this.credentials.tokenAddress) {
      throw new Error("Token address is required");
    }
    if (!this.credentials.verifierAddress) {
      throw new Error("Verifier address is required");
    }
    if (!this.credentials.fhevmInstance) {
      throw new Error("fhevmInstance (from @zama-fhe/relayer-sdk) is required");
    }
  }

  // Lazy-init singleton
  private async getContracts(): Promise<{
    token: Contract;
    verifier: Contract;
    usdc: Contract;
    signer: Wallet;
  }> {
    if (!this.initPromise) {
      this.initPromise = this.initContracts();
    }
    await this.initPromise;
    return {
      token: this.token!,
      verifier: this.verifier!,
      usdc: this.usdc!,
      signer: this.signer!,
    };
  }

  private async initContracts(): Promise<void> {
    const rpc = this.credentials.rpcUrl || "https://ethereum-sepolia-rpc.publicnode.com";
    const provider = new JsonRpcProvider(rpc);
    this.signer = new Wallet(this.credentials.privateKey, provider);

    this.token = new Contract(this.credentials.tokenAddress, TOKEN_ABI, this.signer);

    this.verifier = new Contract(this.credentials.verifierAddress, VERIFIER_ABI, this.signer);

    this.usdc = new Contract(this.credentials.usdcAddress || DEFAULT_USDC, USDC_ABI, this.signer);
  }

  // ============================================================================
  // GameFunction: fhe_wrap
  // ============================================================================

  get wrapFunction() {
    const self = this;
    return new GameFunction({
      name: "fhe_wrap",
      description:
        "Wrap USDC into cUSDC (ERC-7984 confidential token). Converts public USDC into an encrypted balance. Amount is in USDC (e.g. '2' for 2 USDC).",
      args: [
        {
          name: "amount",
          description: "Amount of USDC to wrap (e.g. '2' for 2 USDC, '0.5' for 0.5 USDC)",
        },
      ] as const,
      executable: async (args, logger) => {
        try {
          const amountStr = args.amount;
          if (!amountStr) {
            return new ExecutableGameFunctionResponse(ExecutableGameFunctionStatus.Failed, "Amount is required");
          }

          const amountFloat = parseFloat(amountStr);
          if (isNaN(amountFloat) || amountFloat <= 0) {
            return new ExecutableGameFunctionResponse(
              ExecutableGameFunctionStatus.Failed,
              "Invalid amount. Must be a positive number."
            );
          }
          const rawAmount = BigInt(Math.round(amountFloat * 1_000_000));

          logger(`Wrapping ${amountStr} USDC (${rawAmount} raw units)...`);

          const { token, usdc, signer } = await self.getContracts();
          const signerAddress = await signer.getAddress();

          // Approve USDC to token contract
          const approveTx = await usdc.approve(self.credentials.tokenAddress, rawAmount);
          await approveTx.wait();

          // Wrap (plaintext -- no FHE encryption needed for wrap)
          const tx = await token.wrap(signerAddress, rawAmount);
          const receipt = await tx.wait();

          logger(`Wrap confirmed: TX ${receipt.hash}`);

          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Done,
            JSON.stringify({
              action: "wrap",
              amount: amountStr,
              txHash: receipt.hash,
              blockNumber: receipt.blockNumber,
            })
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return new ExecutableGameFunctionResponse(ExecutableGameFunctionStatus.Failed, `Wrap failed: ${msg}`);
        }
      },
    });
  }

  // ============================================================================
  // GameFunction: fhe_pay
  // ============================================================================

  get payFunction() {
    const self = this;
    return new GameFunction({
      name: "fhe_pay",
      description:
        "Pay another address from your encrypted cUSDC balance using FHE encryption. The actual amount transferred is encrypted on-chain.",
      args: [
        {
          name: "to",
          description: "Recipient Ethereum address (e.g. '0x1234...')",
        },
        {
          name: "amount",
          description: "Amount of USDC to pay (e.g. '1' for 1 USDC)",
        },
        {
          name: "nonce",
          description:
            "Payment nonce for verifier (hex string, e.g. '0xabc...'). If omitted, a random nonce is generated.",
        },
      ] as const,
      executable: async (args, logger) => {
        try {
          const to = args.to;
          const amountStr = args.amount;

          if (!to || !amountStr) {
            return new ExecutableGameFunctionResponse(
              ExecutableGameFunctionStatus.Failed,
              "Both 'to' address and 'amount' are required"
            );
          }

          if (!/^0x[a-fA-F0-9]{40}$/.test(to)) {
            return new ExecutableGameFunctionResponse(
              ExecutableGameFunctionStatus.Failed,
              "Invalid Ethereum address format"
            );
          }

          const amountFloat = parseFloat(amountStr);
          if (isNaN(amountFloat) || amountFloat <= 0) {
            return new ExecutableGameFunctionResponse(
              ExecutableGameFunctionStatus.Failed,
              "Invalid amount. Must be a positive number."
            );
          }
          const rawAmount = BigInt(Math.round(amountFloat * 1_000_000));

          logger(`Encrypting ${amountStr} USDC with @zama-fhe/relayer-sdk...`);

          const { token, verifier, signer } = await self.getContracts();
          const signerAddress = await signer.getAddress();

          // Encrypt amount using @zama-fhe/relayer-sdk
          const input = self.credentials.fhevmInstance.createEncryptedInput(
            self.credentials.tokenAddress,
            signerAddress
          );
          input.add64(rawAmount);
          const encrypted = await input.encrypt();

          // Generate or use provided nonce
          const nonce = args.nonce || ethers.hexlify(ethers.randomBytes(32));

          logger(`Paying ${amountStr} USDC to ${to}...`);

          // Confidential transfer on token
          const tx = await token.confidentialTransfer(to, encrypted.handles[0], encrypted.inputProof);
          const receipt = await tx.wait();

          // Record payment in verifier
          const verifierTx = await verifier.recordPayment(to, nonce, rawAmount);
          const verifierReceipt = await verifierTx.wait();

          logger(`Payment confirmed: TX ${receipt.hash}, Verifier TX ${verifierReceipt.hash}`);

          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Done,
            JSON.stringify({
              action: "pay",
              to,
              amount: amountStr,
              txHash: receipt.hash,
              verifierTxHash: verifierReceipt.hash,
              blockNumber: receipt.blockNumber,
              nonce,
            })
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return new ExecutableGameFunctionResponse(ExecutableGameFunctionStatus.Failed, `Payment failed: ${msg}`);
        }
      },
    });
  }

  // ============================================================================
  // GameFunction: fhe_unwrap
  // ============================================================================

  get unwrapFunction() {
    const self = this;
    return new GameFunction({
      name: "fhe_unwrap",
      description:
        "Unwrap cUSDC back to USDC (step 1 of 2). Encrypts the unwrap amount and submits on-chain. After the KMS processes the decryption, call fhe_finalize_unwrap to complete step 2.",
      args: [
        {
          name: "amount",
          description: "Amount of USDC to unwrap (e.g. '1' for 1 USDC)",
        },
      ] as const,
      executable: async (args, logger) => {
        try {
          const amountStr = args.amount;
          if (!amountStr) {
            return new ExecutableGameFunctionResponse(ExecutableGameFunctionStatus.Failed, "Amount is required");
          }

          const amountFloat = parseFloat(amountStr);
          if (isNaN(amountFloat) || amountFloat <= 0) {
            return new ExecutableGameFunctionResponse(
              ExecutableGameFunctionStatus.Failed,
              "Invalid amount. Must be a positive number."
            );
          }
          const rawAmount = BigInt(Math.round(amountFloat * 1_000_000));

          logger(`Encrypting unwrap amount with @zama-fhe/relayer-sdk...`);

          const { token, signer } = await self.getContracts();
          const signerAddress = await signer.getAddress();

          // Encrypt unwrap amount using @zama-fhe/relayer-sdk
          const input = self.credentials.fhevmInstance.createEncryptedInput(
            self.credentials.tokenAddress,
            signerAddress
          );
          input.add64(rawAmount);
          const encrypted = await input.encrypt();

          logger(`Requesting unwrap of ${amountStr} USDC...`);

          const tx = await token.unwrap(signerAddress, signerAddress, encrypted.handles[0], encrypted.inputProof);
          const receipt = await tx.wait();

          logger(`Unwrap requested: TX ${receipt.hash}. Waiting for KMS finalization.`);

          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Done,
            JSON.stringify({
              action: "unwrap_requested",
              amount: amountStr,
              txHash: receipt.hash,
              blockNumber: receipt.blockNumber,
              note: "Step 1 complete. After KMS processes the decryption, call fhe_finalize_unwrap to finalize.",
            })
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Failed,
            `Unwrap request failed: ${msg}`
          );
        }
      },
    });
  }

  // ============================================================================
  // GameFunction: fhe_balance
  // ============================================================================

  get balanceFunction() {
    const self = this;
    return new GameFunction({
      name: "fhe_balance",
      description:
        "Check the wallet's public USDC balance and encrypted cUSDC balance handle. Decrypting the encrypted balance requires KMS.",
      args: [] as const,
      executable: async (_args, logger) => {
        try {
          logger("Checking balance status...");

          const { usdc, token, signer } = await self.getContracts();
          const address = await signer.getAddress();

          const publicBalance: bigint = await usdc.balanceOf(address);
          const balanceUSDC = (Number(publicBalance) / 1_000_000).toFixed(2);

          // Get encrypted balance handle (can't decrypt without KMS, but shows if non-zero)
          let encryptedBalanceHandle: string = "0x" + "00".repeat(32);
          try {
            encryptedBalanceHandle = await token.confidentialBalanceOf(address);
          } catch {
            /* confidentialBalanceOf may not be available in mock */
          }

          const hasEncryptedBalance = encryptedBalanceHandle !== "0x" + "00".repeat(32);

          logger(`Public USDC: ${balanceUSDC}, Has encrypted balance: ${hasEncryptedBalance}`);

          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Done,
            JSON.stringify({
              action: "balance",
              walletAddress: address,
              publicBalanceUSDC: balanceUSDC,
              publicBalance: publicBalance.toString(),
              encryptedBalanceHandle,
              hasEncryptedBalance,
              note: "Encrypted cUSDC balance handle shown. Decrypting the actual amount requires KMS.",
            })
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Failed,
            `Balance check failed: ${msg}`
          );
        }
      },
    });
  }

  // ============================================================================
  // GameFunction: fhe_finalize_unwrap
  // ============================================================================

  get finalizeUnwrapFunction() {
    const self = this;
    return new GameFunction({
      name: "fhe_finalize_unwrap",
      description:
        "Finalize a pending unwrap (step 2 of 2). The KMS must have processed the decryption request. Call this after fhe_unwrap succeeds.",
      args: [
        {
          name: "burntAmount",
          description: "The encrypted amount handle (bytes32) from the unwrap request",
        },
        {
          name: "cleartextAmount",
          description: "The decrypted amount in raw USDC units (e.g. '1000000' for 1 USDC)",
        },
        {
          name: "decryptionProof",
          description: "The KMS decryption proof (hex string)",
        },
      ] as const,
      executable: async (args, logger) => {
        try {
          if (!args.burntAmount || !args.cleartextAmount || !args.decryptionProof) {
            return new ExecutableGameFunctionResponse(
              ExecutableGameFunctionStatus.Failed,
              "burntAmount, cleartextAmount, and decryptionProof are all required"
            );
          }

          logger("Finalizing unwrap...");

          const { token } = await self.getContracts();

          const tx = await token.finalizeUnwrap(args.burntAmount, BigInt(args.cleartextAmount), args.decryptionProof);
          const receipt = await tx.wait();

          logger(`Unwrap finalized: TX ${receipt.hash}`);

          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Done,
            JSON.stringify({
              action: "unwrap_finalized",
              cleartextAmount: args.cleartextAmount,
              txHash: receipt.hash,
              blockNumber: receipt.blockNumber,
            })
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Failed,
            `Finalize unwrap failed: ${msg}`
          );
        }
      },
    });
  }

  // ============================================================================
  // GameFunction: fhe_info
  // ============================================================================

  get infoFunction() {
    const self = this;
    return new GameFunction({
      name: "fhe_info",
      description: "Get token address, verifier address, network, and wallet address information.",
      args: [] as const,
      executable: async (_args, logger) => {
        try {
          const { signer } = await self.getContracts();
          const address = await signer.getAddress();

          logger("Fetching info...");

          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Done,
            JSON.stringify({
              action: "info",
              network: "Ethereum Sepolia",
              chainId: self.credentials.chainId || 11155111,
              tokenAddress: self.credentials.tokenAddress,
              verifierAddress: self.credentials.verifierAddress,
              walletAddress: address,
              scheme: "fhe-confidential-v1",
            })
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return new ExecutableGameFunctionResponse(ExecutableGameFunctionStatus.Failed, `Info failed: ${msg}`);
        }
      },
    });
  }

  // ============================================================================
  // Worker
  // ============================================================================

  public getWorker(data?: {
    functions?: GameFunction<any>[];
    getEnvironment?: () => Promise<Record<string, any>>;
  }): GameWorker {
    const self = this;
    return new GameWorker({
      id: this.id,
      name: this.name,
      description: this.description,
      functions: data?.functions || [
        this.wrapFunction,
        this.payFunction,
        this.unwrapFunction,
        this.finalizeUnwrapFunction,
        this.balanceFunction,
        this.infoFunction,
      ],
      getEnvironment:
        data?.getEnvironment ||
        (async () => {
          try {
            const { signer } = await self.getContracts();
            return {
              network: "Ethereum Sepolia",
              token_address: self.credentials.tokenAddress,
              verifier_address: self.credentials.verifierAddress,
              wallet_address: await signer.getAddress(),
            };
          } catch {
            return {
              network: "Ethereum Sepolia",
              token_address: self.credentials.tokenAddress,
              verifier_address: self.credentials.verifierAddress,
              wallet_address: "unknown",
            };
          }
        }),
    });
  }
}

export default FhePlugin;
export { FhePlugin };
