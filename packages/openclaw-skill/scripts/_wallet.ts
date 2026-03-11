import { JsonRpcProvider, Wallet, Contract } from "ethers";
import { TOKEN_ABI, VERIFIER_ABI } from "fhe-x402-sdk";
import type { FhevmInstance } from "fhe-x402-sdk";
import { parseArgs } from "node:util";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TOKEN = "0x3864B98D1B1EC2109C679679052e2844b4153889";
const DEFAULT_VERIFIER = "0xCc60280A10FEB7fBdf20fBefc2abe6E0e99A5A83";
const DEFAULT_USDC = "0xc89e913676B034f8b38E49f7508803d1cDEC9F4f";
const DEFAULT_GATEWAY = "https://gateway.sepolia.zama.ai";

const USDC_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
];

// ============================================================================
// Singleton
// ============================================================================

let token: Contract | null = null;
let verifier: Contract | null = null;
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

  const tokenAddr = process.env.TOKEN_ADDRESS || DEFAULT_TOKEN;
  const verifierAddr = process.env.VERIFIER_ADDRESS || DEFAULT_VERIFIER;
  const usdcAddr = process.env.USDC_ADDRESS || DEFAULT_USDC;

  token = new Contract(tokenAddr, TOKEN_ABI, signer);
  verifier = new Contract(verifierAddr, VERIFIER_ABI, signer);
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
  token: Contract;
  verifier: Contract;
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
    token: token!,
    verifier: verifier!,
    usdc: usdc!,
    signer: signer!,
    provider: provider!,
    fhevmInstance: fhevmInstance!,
  };
}

export function getTokenAddress(): string {
  return process.env.TOKEN_ADDRESS || DEFAULT_TOKEN;
}

export function getVerifierAddress(): string {
  return process.env.VERIFIER_ADDRESS || DEFAULT_VERIFIER;
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
