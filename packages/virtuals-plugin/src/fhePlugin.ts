import {
  GameWorker,
  GameFunction,
  ExecutableGameFunctionResponse,
  ExecutableGameFunctionStatus,
} from "@virtuals-protocol/game";
import { JsonRpcProvider, Wallet, Contract, ethers } from "ethers";
import { POOL_ABI } from "fhe-x402-sdk";
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
    poolAddress: string;
    usdcAddress?: string;
    chainId?: number;
    /** Required: fhevmjs instance for FHE encryption */
    fhevmInstance: FhevmInstance;
  };
}

const DEFAULT_USDC = "0x229146B746cf3A314dee33f08b84f8EFd5F314F4";
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
  private pool: Contract | null = null;
  private usdc: Contract | null = null;
  private signer: Wallet | null = null;
  private initPromise: Promise<void> | null = null;
  private credentials: IFhePluginOptions["credentials"];

  constructor(options: IFhePluginOptions) {
    this.id = options.id || "fhe_x402_worker";
    this.name = options.name || "FHE x402 Payment Worker";
    this.description =
      options.description ||
      "Manages encrypted USDC payments using FHE on Ethereum. Can deposit, pay, request withdraw, and check status.";
    this.credentials = options.credentials;

    if (!this.credentials.privateKey) {
      throw new Error("Private key is required");
    }
    if (!this.credentials.poolAddress) {
      throw new Error("Pool address is required");
    }
    if (!this.credentials.fhevmInstance) {
      throw new Error("fhevmjs instance is required");
    }
  }

  // Lazy-init singleton
  private async getContracts(): Promise<{
    pool: Contract;
    usdc: Contract;
    signer: Wallet;
  }> {
    if (!this.initPromise) {
      this.initPromise = this.initContracts();
    }
    await this.initPromise;
    return { pool: this.pool!, usdc: this.usdc!, signer: this.signer! };
  }

  private async initContracts(): Promise<void> {
    const rpc = this.credentials.rpcUrl || "https://ethereum-sepolia-rpc.publicnode.com";
    const provider = new JsonRpcProvider(rpc);
    this.signer = new Wallet(this.credentials.privateKey, provider);

    this.pool = new Contract(
      this.credentials.poolAddress,
      POOL_ABI,
      this.signer
    );

    this.usdc = new Contract(
      this.credentials.usdcAddress || DEFAULT_USDC,
      USDC_ABI,
      this.signer
    );
  }

  // ============================================================================
  // GameFunction: fhe_deposit
  // ============================================================================

  get depositFunction() {
    const self = this;
    return new GameFunction({
      name: "fhe_deposit",
      description:
        "Deposit USDC into the FHE payment pool. Converts public USDC into an encrypted balance. Amount is in USDC (e.g. '2' for 2 USDC).",
      args: [
        {
          name: "amount",
          description: "Amount of USDC to deposit (e.g. '2' for 2 USDC, '0.5' for 0.5 USDC)",
        },
      ] as const,
      executable: async (args, logger) => {
        try {
          const amountStr = args.amount;
          if (!amountStr) {
            return new ExecutableGameFunctionResponse(
              ExecutableGameFunctionStatus.Failed,
              "Amount is required"
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

          logger(`Depositing ${amountStr} USDC (${rawAmount} raw units)...`);

          const { pool, usdc } = await self.getContracts();

          // Approve USDC
          const approveTx = await usdc.approve(
            self.credentials.poolAddress,
            rawAmount
          );
          await approveTx.wait();

          // Deposit (plaintext — no FHE encryption needed for deposit)
          const tx = await pool.deposit(rawAmount);
          const receipt = await tx.wait();

          logger(`Deposit confirmed: TX ${receipt.hash}`);

          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Done,
            JSON.stringify({
              action: "deposit",
              amount: amountStr,
              txHash: receipt.hash,
              blockNumber: receipt.blockNumber,
            })
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Failed,
            `Deposit failed: ${msg}`
          );
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
        "Pay another address from your encrypted pool balance using FHE encryption. The actual amount transferred is encrypted on-chain.",
      args: [
        {
          name: "to",
          description: "Recipient Ethereum address (e.g. '0x1234...')",
        },
        {
          name: "amount",
          description: "Amount of USDC to pay (e.g. '1' for 1 USDC)",
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

          logger(`Encrypting ${amountStr} USDC with fhevmjs...`);

          const { pool, signer } = await self.getContracts();
          const signerAddress = await signer.getAddress();

          // Encrypt amount using fhevmjs
          const input = self.credentials.fhevmInstance.createEncryptedInput(
            self.credentials.poolAddress,
            signerAddress
          );
          input.add64(rawAmount);
          const encrypted = await input.encrypt();

          // Generate random nonce
          const nonce = ethers.hexlify(ethers.randomBytes(32));

          logger(`Paying ${amountStr} USDC to ${to}...`);

          const tx = await pool.pay(
            to,
            encrypted.handles[0],
            encrypted.inputProof,
            rawAmount,
            nonce,
            ethers.ZeroHash
          );
          const receipt = await tx.wait();

          logger(`Payment confirmed: TX ${receipt.hash}`);

          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Done,
            JSON.stringify({
              action: "pay",
              to,
              amount: amountStr,
              txHash: receipt.hash,
              blockNumber: receipt.blockNumber,
              nonce,
            })
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Failed,
            `Payment failed: ${msg}`
          );
        }
      },
    });
  }

  // ============================================================================
  // GameFunction: fhe_withdraw
  // ============================================================================

  get withdrawFunction() {
    const self = this;
    return new GameFunction({
      name: "fhe_withdraw",
      description:
        "Request withdrawal from the FHE payment pool (step 1 of 2). Encrypts the withdrawal amount and submits on-chain. Step 2 (finalize) requires async KMS decryption callback.",
      args: [
        {
          name: "amount",
          description: "Amount of USDC to withdraw (e.g. '1' for 1 USDC)",
        },
      ] as const,
      executable: async (args, logger) => {
        try {
          const amountStr = args.amount;
          if (!amountStr) {
            return new ExecutableGameFunctionResponse(
              ExecutableGameFunctionStatus.Failed,
              "Amount is required"
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

          logger(`Encrypting withdrawal amount with fhevmjs...`);

          const { pool, signer } = await self.getContracts();
          const signerAddress = await signer.getAddress();

          // Encrypt withdrawal amount using fhevmjs
          const input = self.credentials.fhevmInstance.createEncryptedInput(
            self.credentials.poolAddress,
            signerAddress
          );
          input.add64(rawAmount);
          const encrypted = await input.encrypt();

          logger(`Requesting withdrawal of ${amountStr} USDC...`);

          const tx = await pool.requestWithdraw(
            encrypted.handles[0],
            encrypted.inputProof
          );
          const receipt = await tx.wait();

          logger(`Withdrawal requested: TX ${receipt.hash}. Waiting for KMS finalization.`);

          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Done,
            JSON.stringify({
              action: "withdraw_requested",
              amount: amountStr,
              txHash: receipt.hash,
              blockNumber: receipt.blockNumber,
              note: "Step 1 complete. Step 2 (finalize) requires async KMS callback.",
            })
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Failed,
            `Withdrawal request failed: ${msg}`
          );
        }
      },
    });
  }

  // ============================================================================
  // GameFunction: fhe_finalize_withdraw
  // ============================================================================

  get finalizeWithdrawFunction() {
    const self = this;
    return new GameFunction({
      name: "fhe_finalize_withdraw",
      description:
        "Finalize a pending withdrawal (step 2 of 2). Requires the clear amount and decryption proof from the KMS gateway. This completes the withdrawal and transfers USDC back to your wallet.",
      args: [
        {
          name: "clearAmount",
          description: "The decrypted withdrawal amount in raw USDC units (e.g. '1000000' for 1 USDC)",
        },
        {
          name: "decryptionProof",
          description: "The KMS decryption proof (hex bytes)",
        },
      ] as const,
      executable: async (args, logger) => {
        try {
          const clearAmountStr = args.clearAmount;
          const proofStr = args.decryptionProof;

          if (!clearAmountStr || !proofStr) {
            return new ExecutableGameFunctionResponse(
              ExecutableGameFunctionStatus.Failed,
              "Both 'clearAmount' and 'decryptionProof' are required"
            );
          }

          const clearAmount = parseInt(clearAmountStr);
          if (isNaN(clearAmount) || clearAmount < 0) {
            return new ExecutableGameFunctionResponse(
              ExecutableGameFunctionStatus.Failed,
              "Invalid clearAmount. Must be a non-negative integer."
            );
          }

          logger(`Finalizing withdrawal of ${clearAmount} raw units...`);

          const { pool } = await self.getContracts();
          const tx = await pool.finalizeWithdraw(clearAmount, proofStr);
          const receipt = await tx.wait();

          const amountUSDC = (clearAmount / 1_000_000).toFixed(2);
          logger(`Withdrawal finalized: ${amountUSDC} USDC | TX: ${receipt.hash}`);

          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Done,
            JSON.stringify({
              action: "withdraw_finalized",
              amount: amountUSDC,
              clearAmount: clearAmountStr,
              txHash: receipt.hash,
              blockNumber: receipt.blockNumber,
            })
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Failed,
            `Finalize withdrawal failed: ${msg}`
          );
        }
      },
    });
  }

  // ============================================================================
  // GameFunction: fhe_cancel_withdraw
  // ============================================================================

  get cancelWithdrawFunction() {
    const self = this;
    return new GameFunction({
      name: "fhe_cancel_withdraw",
      description:
        "Cancel a pending withdrawal request and refund the amount back to your encrypted pool balance.",
      args: [] as const,
      executable: async (_args, logger) => {
        try {
          logger("Cancelling pending withdrawal...");

          const { pool } = await self.getContracts();
          const tx = await pool.cancelWithdraw();
          const receipt = await tx.wait();

          logger(`Withdrawal cancelled: TX ${receipt.hash}`);

          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Done,
            JSON.stringify({
              action: "withdraw_cancelled",
              txHash: receipt.hash,
              blockNumber: receipt.blockNumber,
            })
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Failed,
            `Cancel withdrawal failed: ${msg}`
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
        "Check if the wallet has been initialized in the FHE pool and view public USDC balance.",
      args: [] as const,
      executable: async (_args, logger) => {
        try {
          logger("Checking balance status...");

          const { pool, usdc, signer } = await self.getContracts();
          const address = await signer.getAddress();

          const isInit = await pool.isInitialized(address);
          const publicBalance: bigint = await usdc.balanceOf(address);
          const balanceUSDC = (Number(publicBalance) / 1_000_000).toFixed(2);

          logger(`Public USDC: ${balanceUSDC}, Pool initialized: ${isInit}`);

          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Done,
            JSON.stringify({
              action: "balance",
              walletAddress: address,
              publicBalanceUSDC: balanceUSDC,
              publicBalance: publicBalance.toString(),
              isInitialized: isInit,
              note: "Encrypted balance requires KMS decryption via requestBalance().",
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
  // GameFunction: fhe_info
  // ============================================================================

  get infoFunction() {
    const self = this;
    return new GameFunction({
      name: "fhe_info",
      description: "Get pool address, network, and wallet address information.",
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
              poolAddress: self.credentials.poolAddress,
              walletAddress: address,
              scheme: "fhe-confidential-v1",
            })
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Failed,
            `Info failed: ${msg}`
          );
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
        this.depositFunction,
        this.payFunction,
        this.withdrawFunction,
        this.finalizeWithdrawFunction,
        this.cancelWithdrawFunction,
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
              pool_address: self.credentials.poolAddress,
              wallet_address: await signer.getAddress(),
            };
          } catch {
            return {
              network: "Ethereum Sepolia",
              pool_address: self.credentials.poolAddress,
              wallet_address: "unknown",
            };
          }
        }),
    });
  }
}

export default FhePlugin;
export { FhePlugin };
