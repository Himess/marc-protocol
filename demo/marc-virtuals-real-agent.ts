/**
 * MARC Protocol × Virtuals — Real Autonomous GAME Agent Demo
 *
 * Creates a REAL GameAgent using the Virtuals Protocol GAME API.
 * The agent autonomously decides to: check balance → wrap USDC → FHE pay → check balance.
 * All on-chain transactions are real (Ethereum Sepolia).
 *
 * Usage:
 *   PRIVATE_KEY=0x... GAME_API_KEY=apt-... npx tsx demo/marc-virtuals-real-agent.ts
 *
 * Requires:
 *   - Ethereum Sepolia ETH (>= 0.01)
 *   - USDC on Sepolia (>= 2) — auto-mints if low
 *   - Virtuals GAME API key (https://game.virtuals.io)
 */

import { GameAgent } from "@virtuals-protocol/game";
import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits } from "ethers";
import { createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/node";
import { FhePlugin } from "../packages/virtuals-plugin/src/fhePlugin.js";

// ============================================================================
// ANSI Colors
// ============================================================================

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";

// ============================================================================
// Contract Addresses (Sepolia V4.3)
// ============================================================================

const USDC_ADDRESS = "0xc89e913676B034f8b38E49f7508803d1cDEC9F4f";
const TOKEN_ADDRESS = "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D";
const VERIFIER_ADDRESS = "0x4503A7aee235aBD10e6064BBa8E14235fdF041f4";

const USDC_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function mint(address to, uint256 amount) external",
];

const ETHERSCAN = "https://sepolia.etherscan.io";

// ============================================================================
// Main
// ============================================================================

async function main() {
  // ── Validate ENV ──
  if (!process.env.PRIVATE_KEY) {
    console.error(`${RED}ERROR: Set PRIVATE_KEY environment variable${RESET}`);
    console.error("Usage: PRIVATE_KEY=0x... GAME_API_KEY=apt-... npx tsx demo/marc-virtuals-real-agent.ts");
    process.exit(1);
  }
  if (!process.env.GAME_API_KEY) {
    console.error(`${RED}ERROR: Set GAME_API_KEY environment variable${RESET}`);
    console.error("Get your key at https://game.virtuals.io");
    process.exit(1);
  }

  const rpcUrl = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
  const provider = new JsonRpcProvider(rpcUrl);
  const signer = new Wallet(process.env.PRIVATE_KEY, provider);
  const address = await signer.getAddress();
  const usdc = new Contract(USDC_ADDRESS, USDC_ABI, signer);

  // ── Header ──
  console.log("");
  console.log(`${CYAN}${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${CYAN}${BOLD}║  MARC Protocol × Virtuals — Real Autonomous Agent        ║${RESET}`);
  console.log(`${CYAN}${BOLD}║  FHE-Powered x402 Payment via GAME Protocol              ║${RESET}`);
  console.log(`${CYAN}${BOLD}║  Network: Ethereum Sepolia (11155111)                     ║${RESET}`);
  console.log(`${CYAN}${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log("");

  // ── Wallet Info ──
  const ethBal = await provider.getBalance(address);
  const usdcBal: bigint = await usdc.balanceOf(address);

  console.log(`   ${DIM}Agent Wallet${RESET}       ${CYAN}${address}${RESET}`);
  console.log(`   ${DIM}ETH Balance${RESET}        ${GREEN}${parseFloat(formatUnits(ethBal, 18)).toFixed(4)} ETH${RESET}`);
  console.log(`   ${DIM}USDC Balance${RESET}       ${GREEN}${formatUnits(usdcBal, 6)} USDC${RESET}`);
  console.log(`   ${DIM}Scheme${RESET}             fhe-confidential-v1`);
  console.log(`   ${DIM}GAME API Key${RESET}       ${process.env.GAME_API_KEY.slice(0, 12)}...${RESET}`);
  console.log("");

  // ── Mint USDC if needed ──
  if (usdcBal < parseUnits("2", 6)) {
    console.log(`   ${YELLOW}Low USDC balance — minting 10 test USDC...${RESET}`);
    const mintTx = await usdc.mint(address, parseUnits("10", 6));
    await mintTx.wait();
    console.log(`   ${GREEN}Minted 10 USDC${RESET}\n`);
  }

  // ── Initialize FHE Engine ──
  console.log(`   ${CYAN}Initializing Zama FHE encryption engine...${RESET}`);
  const fhevmInstance = await createInstance({ ...SepoliaConfig, network: rpcUrl });
  console.log(`   ${GREEN}✓ FHE engine ready${RESET}\n`);

  // ── Create FHE Plugin ──
  const plugin = new FhePlugin({
    name: "MARC FHE Payment Worker",
    description: "Manages encrypted USDC payments using Zama FHE on Ethereum Sepolia. Can wrap USDC into encrypted cUSDC, make confidential transfers, check balances, and record x402 payment nonces.",
    credentials: {
      privateKey: process.env.PRIVATE_KEY,
      rpcUrl,
      tokenAddress: TOKEN_ADDRESS,
      verifierAddress: VERIFIER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      fhevmInstance: fhevmInstance as any,
    },
  });

  const worker = plugin.getWorker();
  console.log(`   ${GREEN}✓ FHE Plugin created:${RESET} ${worker.functions.length} GameFunctions`);
  console.log(`   ${DIM}  Functions: fhe_wrap, fhe_pay, fhe_unwrap, fhe_balance, fhe_info${RESET}\n`);

  // ── Create GAME Agent ──
  const serverAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

  const agent = new GameAgent(process.env.GAME_API_KEY, {
    name: "MARC-Agent",
    goal: `You are an AI agent that needs to pay for a premium API using encrypted payments. Follow these steps in order:
1. First check your balance using fhe_balance
2. Wrap 1 USDC into encrypted cUSDC using fhe_wrap with amount "1"
3. Pay 0.50 USDC to ${serverAddress} using fhe_pay with to="${serverAddress}" and amount="0.50"
4. Check your balance again using fhe_balance to confirm the payment went through`,
    description: "An autonomous AI payment agent using MARC Protocol. You make FHE-encrypted payments — the transfer amounts are hidden on-chain using Zama's Fully Homomorphic Encryption. You operate on Ethereum Sepolia using the fhe-confidential-v1 scheme.",
    workers: [worker],
  });

  // ── Custom Logger ──
  agent.setLogger((a, msg) => {
    const ts = new Date().toISOString().split("T")[1]!.slice(0, 8);
    console.log(`   ${DIM}[${ts}]${RESET} ${MAGENTA}[${a.name}]${RESET} ${msg}`);
  });

  console.log(`   ${GREEN}✓ GameAgent created:${RESET} "${agent.name}"`);
  console.log(`   ${DIM}  Target: Pay 0.50 encrypted USDC to ${serverAddress.slice(0, 12)}...${RESET}\n`);

  // ── Initialize Agent ──
  console.log(`${CYAN}${BOLD}━━━ INITIALIZING GAME AGENT ━━━${RESET}\n`);
  await agent.init();
  console.log(`   ${GREEN}✓ Agent initialized — ready for autonomous steps${RESET}\n`);

  // ── Run Autonomous Steps ──
  const maxSteps = 6;
  console.log(`${CYAN}${BOLD}━━━ RUNNING ${maxSteps} AUTONOMOUS STEPS ━━━${RESET}\n`);

  for (let i = 1; i <= maxSteps; i++) {
    console.log(`${BLUE}${BOLD}   ▶ STEP ${i}/${maxSteps}${RESET}`);
    console.log(`   ${DIM}${"─".repeat(50)}${RESET}`);

    try {
      const action = await agent.step({ verbose: true });
      console.log(`   ${GREEN}✓ Result: ${action}${RESET}\n`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`   ${RED}✗ Step ${i} error: ${msg}${RESET}\n`);
    }
  }

  // ── Summary ──
  console.log("");
  console.log(`${CYAN}${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${CYAN}${BOLD}║  ${GREEN}Autonomous GAME agent completed ${maxSteps} steps.${CYAN}               ║${RESET}`);
  console.log(`${CYAN}${BOLD}║                                                          ║${RESET}`);
  console.log(`${CYAN}${BOLD}║  Agent: MARC-Agent (Virtuals GAME Protocol)               ║${RESET}`);
  console.log(`${CYAN}${BOLD}║  Plugin: FHE x402 Payment Worker                          ║${RESET}`);
  console.log(`${CYAN}${BOLD}║  Chain: Ethereum Sepolia (real transactions)               ║${RESET}`);
  console.log(`${CYAN}${BOLD}║  Privacy: FHE-encrypted amounts (Zama fhEVM)              ║${RESET}`);
  console.log(`${CYAN}${BOLD}║  github.com/Himess/marc-protocol                          ║${RESET}`);
  console.log(`${CYAN}${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log("");
}

main().catch((err) => {
  console.error(`\n${RED}${BOLD}Fatal: ${err.message}${RESET}`);
  console.error(`${DIM}${err.stack}${RESET}`);
  process.exit(1);
});
