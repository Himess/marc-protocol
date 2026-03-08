import { JsonRpcProvider, Wallet, Contract } from "ethers";
import { POOL_ABI } from "fhe-x402-sdk";
import type { FhevmInstance } from "fhe-x402-sdk";
import { parseArgs } from "node:util";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_POOL = "0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73";
const DEFAULT_USDC = "0x229146B746cf3A314dee33f08b84f8EFd5F314F4";
const DEFAULT_GATEWAY = "https://gateway.sepolia.zama.ai";

const USDC_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
];

// ============================================================================
// Singleton
// ============================================================================

let pool: Contract | null = null;
let usdc: Contract | null = null;
let signer: Wallet | null = null;
let provider: JsonRpcProvider | null = null;
let fhevmInstance: FhevmInstance | null = null;
let initPromise: Promise<void> | null = null;

async function initContracts(): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY env var is required");

  const rpc = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
  provider = new JsonRpcProvider(rpc);
  signer = new Wallet(privateKey, provider);

  const poolAddr = process.env.POOL_ADDRESS || DEFAULT_POOL;
  const usdcAddr = process.env.USDC_ADDRESS || DEFAULT_USDC;

  pool = new Contract(poolAddr, POOL_ABI, signer);
  usdc = new Contract(usdcAddr, USDC_ABI, signer);

  // Initialize fhevmjs for FHE encryption
  const fhevmjs = await import("fhevmjs");
  await fhevmjs.initFhevm();
  fhevmInstance = await fhevmjs.createInstance({
    chainId: parseInt(process.env.CHAIN_ID || "11155111"),
    networkUrl: rpc,
    gatewayUrl: process.env.GATEWAY_URL || DEFAULT_GATEWAY,
  });
}

export async function getContracts(): Promise<{
  pool: Contract;
  usdc: Contract;
  signer: Wallet;
  provider: JsonRpcProvider;
  fhevmInstance: FhevmInstance;
}> {
  if (!initPromise) {
    initPromise = initContracts();
  }
  await initPromise;
  return {
    pool: pool!,
    usdc: usdc!,
    signer: signer!,
    provider: provider!,
    fhevmInstance: fhevmInstance!,
  };
}

export function getPoolAddress(): string {
  return process.env.POOL_ADDRESS || DEFAULT_POOL;
}

// ============================================================================
// Helpers
// ============================================================================

export function parseAmount(str: string): bigint {
  const trimmed = str.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("Invalid amount. Must be a positive number.");
  }
  const parts = trimmed.split(".");
  const intPart = parts[0];
  const decPart = (parts[1] || "").padEnd(6, "0").slice(0, 6);
  const raw = BigInt(intPart) * 1_000_000n + BigInt(decPart);
  if (raw <= 0n) {
    throw new Error("Invalid amount. Must be a positive number.");
  }
  return raw;
}

export function formatUSDC(raw: bigint): string {
  return (Number(raw) / 1_000_000).toFixed(2);
}

export function ok(data: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...data });
}

export function fail(msg: string): string {
  return JSON.stringify({ ok: false, error: msg });
}

export function parseCliArgs(argv: string[]): Record<string, string> {
  const options: Record<string, { type: "string" }> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      options[argv[i].slice(2)] = { type: "string" };
    }
  }

  const { values } = parseArgs({
    args: argv,
    options,
    strict: false,
  });

  return values as Record<string, string>;
}
