/**
 * FHE x402 Plugin for ElizaOS
 *
 * Adds encrypted USDC payment actions to an ElizaOS agent.
 * Uses FHE to hide payment amounts on-chain.
 */

import { fheFetch, POOL_ABI } from "fhe-x402-sdk";
import type { FhevmInstance } from "fhe-x402-sdk";
import { JsonRpcProvider, Wallet, Contract, ethers } from "ethers";
import { initFhevm, createInstance } from "fhevmjs";

// ElizaOS plugin interface (simplified)
interface Action {
  name: string;
  description: string;
  handler: (context: ActionContext) => Promise<ActionResult>;
}

interface ActionContext {
  params: Record<string, string>;
  getService: (name: string) => unknown;
}

interface ActionResult {
  success: boolean;
  data?: unknown;
  message?: string;
}

interface Plugin {
  name: string;
  actions: Action[];
  initialize: () => Promise<void>;
}

const POOL_ADDRESS = "0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73";
const USDC_ADDRESS = "0x229146B746cf3A314dee33f08b84f8EFd5F314F4";
const GATEWAY_URL = "https://gateway.sepolia.zama.ai";

let pool: Contract;
let signer: Wallet;
let fhevmInstance: FhevmInstance;

export const fhePlugin: Plugin = {
  name: "fhe-x402",

  actions: [
    {
      name: "FHE_PAY",
      description: "Make an encrypted payment to access a paid API endpoint via fheFetch",
      handler: async (ctx: ActionContext): Promise<ActionResult> => {
        const url = ctx.params.url;
        if (!url) return { success: false, message: "URL required" };

        // fheFetch handles the 402 flow automatically:
        // 1. GET url → 402
        // 2. Encrypt amount with fhevmjs → pool.pay()
        // 3. Retry with Payment header → 200
        try {
          const response = await fheFetch(url, {
            poolAddress: POOL_ADDRESS,
            rpcUrl: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
            signer,
            fhevmInstance,
          });
          if (response.ok) {
            const data = await response.json();
            return { success: true, data };
          }
          return { success: false, message: `Payment failed: ${response.status}` };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { success: false, message: msg };
        }
      },
    },

    {
      name: "FHE_BALANCE",
      description: "Check the agent's public USDC balance and pool initialization status",
      handler: async (): Promise<ActionResult> => {
        const address = await signer.getAddress();
        const isInit = await pool.isInitialized(address);
        const usdc = new Contract(
          USDC_ADDRESS,
          ["function balanceOf(address) view returns (uint256)"],
          signer
        );
        const balance: bigint = await usdc.balanceOf(address);
        const formatted = (Number(balance) / 1_000_000).toFixed(2);
        return {
          success: true,
          data: { balance: formatted, raw: balance.toString(), isInitialized: isInit },
          message: `Public USDC: ${formatted}, Pool initialized: ${isInit}`,
        };
      },
    },

    {
      name: "FHE_DEPOSIT",
      description: "Deposit USDC into the FHE encrypted payment pool",
      handler: async (ctx: ActionContext): Promise<ActionResult> => {
        const amount = ctx.params.amount;
        if (!amount) return { success: false, message: "Amount required (in USDC)" };

        const amountRaw = BigInt(Math.round(parseFloat(amount) * 1_000_000));

        // Approve + deposit (plaintext — no FHE encryption needed for deposit)
        const usdc = new Contract(
          USDC_ADDRESS,
          ["function approve(address, uint256) returns (bool)"],
          signer
        );
        const approveTx = await usdc.approve(POOL_ADDRESS, amountRaw);
        await approveTx.wait();

        const tx = await pool.deposit(amountRaw);
        const receipt = await tx.wait();

        return {
          success: true,
          data: { txHash: receipt.hash, amount },
          message: `Deposited ${amount} USDC | TX: ${receipt.hash}`,
        };
      },
    },

    {
      name: "FHE_WITHDRAW_FINALIZE",
      description: "Finalize a pending withdrawal (step 2 of 2). Requires the clear amount and decryption proof from the KMS gateway.",
      handler: async (ctx: ActionContext): Promise<ActionResult> => {
        const clearAmountStr = ctx.params.clearAmount;
        const proof = ctx.params.proof || ctx.params.decryptionProof;

        if (!clearAmountStr || !proof) {
          return { success: false, message: "Both clearAmount and proof are required" };
        }

        const clearAmount = parseInt(clearAmountStr);
        if (isNaN(clearAmount) || clearAmount < 0) {
          return { success: false, message: "Invalid clearAmount. Must be a non-negative integer." };
        }

        try {
          const tx = await pool.finalizeWithdraw(clearAmount, proof);
          const receipt = await tx.wait();

          const amountUSDC = (clearAmount / 1_000_000).toFixed(2);

          return {
            success: true,
            data: {
              action: "withdraw_finalized",
              amount: amountUSDC,
              clearAmount: clearAmountStr,
              txHash: receipt.hash,
              blockNumber: receipt.blockNumber,
            },
            message: `Withdrawal finalized: ${amountUSDC} USDC | TX: ${receipt.hash}`,
          };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { success: false, message: `Finalize withdrawal failed: ${msg}` };
        }
      },
    },

    {
      name: "FHE_CANCEL_WITHDRAW",
      description: "Cancel a pending withdrawal request and refund the amount back to your encrypted pool balance.",
      handler: async (): Promise<ActionResult> => {
        try {
          const tx = await pool.cancelWithdraw();
          const receipt = await tx.wait();

          return {
            success: true,
            data: {
              action: "withdraw_cancelled",
              txHash: receipt.hash,
              blockNumber: receipt.blockNumber,
            },
            message: `Withdrawal cancelled | TX: ${receipt.hash}`,
          };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { success: false, message: `Cancel withdrawal failed: ${msg}` };
        }
      },
    },
  ],

  initialize: async () => {
    const rpcUrl = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
    const provider = new JsonRpcProvider(rpcUrl);
    signer = new Wallet(process.env.PRIVATE_KEY!, provider);
    pool = new Contract(POOL_ADDRESS, POOL_ABI, signer);

    // Initialize fhevmjs for real FHE encryption
    await initFhevm();
    fhevmInstance = await createInstance({
      chainId: 11155111,
      networkUrl: rpcUrl,
      gatewayUrl: GATEWAY_URL,
    }) as unknown as FhevmInstance;

    console.log("[FHE x402] Plugin initialized with fhevmjs");
  },
};
