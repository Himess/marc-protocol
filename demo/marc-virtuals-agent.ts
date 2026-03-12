/**
 * MARC Protocol — Virtuals Autonomous Agent Demo
 *
 * Video-ready terminal demo simulating an autonomous AI agent using
 * the Virtuals GAME protocol with MARC's FHE payment infrastructure.
 *
 * Flow:
 *   Phase 1: Agent Initialization (wallet + balance discovery)
 *   Phase 2: HTTP 402 Discovery (API paywall detection)
 *   Phase 3: fhe_wrap — Convert USDC → Encrypted cUSDC
 *   Phase 4: fhe_pay — FHE Encrypted Payment
 *   Phase 5: Server Verification → 200 OK (Access Granted)
 *   Phase 6: Post-Payment Status (balance + nonce + summary)
 *
 * Usage: PRIVATE_KEY=0x... npx tsx demo/marc-virtuals-agent.ts
 * Requires: Ethereum Sepolia ETH (>= 0.01) + USDC (>= 2)
 */

import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits, ethers } from "ethers";
import { createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/node";

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
const WHITE = "\x1b[37m";

// ============================================================================
// Contracts (Sepolia V4.3)
// ============================================================================

const USDC_ADDRESS = "0xc89e913676B034f8b38E49f7508803d1cDEC9F4f";
const TOKEN_ADDRESS = "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D";
const VERIFIER_ADDRESS = "0x4503A7aee235aBD10e6064BBa8E14235fdF041f4";

const ETHERSCAN = "https://sepolia.etherscan.io";

const USDC_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function mint(address to, uint256 amount) external",
];

const TOKEN_ABI = [
  "function wrap(address to, uint256 amount) external",
  "function confidentialTransfer(address to, bytes32 handle, bytes calldata inputProof) external",
  "function confidentialBalanceOf(address) view returns (bytes32)",
  "function accumulatedFees() view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
];

const VERIFIER_ABI = [
  "function recordPayment(address server, bytes32 nonce, uint64 minPrice) external",
  "function usedNonces(bytes32) view returns (bool)",
];

// ============================================================================
// Display Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function agentLog(message: string) {
  const ts = new Date().toISOString().split("T")[1]!.slice(0, 8);
  console.log(`   ${DIM}[${ts}]${RESET} ${MAGENTA}[AGENT]${RESET} ${message}`);
}

function serverLog(message: string) {
  const ts = new Date().toISOString().split("T")[1]!.slice(0, 8);
  console.log(`   ${DIM}[${ts}]${RESET} ${BLUE}[SERVER]${RESET} ${message}`);
}

function gameLog(action: string, status: string) {
  const ts = new Date().toISOString().split("T")[1]!.slice(0, 8);
  console.log(`   ${DIM}[${ts}]${RESET} ${CYAN}[GAME]${RESET} ${YELLOW}${action}${RESET} → ${status}`);
}

function printHeader() {
  console.log("");
  console.log(`${CYAN}${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${CYAN}${BOLD}║  MARC Protocol — Virtuals Autonomous Agent Demo          ║${RESET}`);
  console.log(`${CYAN}${BOLD}║  FHE-Powered x402 Payment for AI Agents                  ║${RESET}`);
  console.log(`${CYAN}${BOLD}║  Virtuals GAME Protocol Integration                      ║${RESET}`);
  console.log(`${CYAN}${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);
}

function printPhase(phase: number, title: string) {
  console.log("");
  console.log(`   ${BOLD}${CYAN}━━━ PHASE ${phase}: ${title} ━━━${RESET}`);
  console.log("");
}

function printTxBox(hash: string, gasUsed: bigint, label: string) {
  const shortHash = `${hash.slice(0, 14)}...${hash.slice(-10)}`;
  console.log(`   ${GREEN}┌─── ${label} ${"─".repeat(Math.max(0, 40 - label.length))}┐${RESET}`);
  console.log(`   ${GREEN}│${RESET} TX:  ${CYAN}${shortHash}${RESET}`);
  console.log(`   ${GREEN}│${RESET} Gas: ${YELLOW}${gasUsed.toLocaleString()}${RESET}`);
  console.log(`   ${GREEN}│${RESET} ${DIM}${ETHERSCAN}/tx/${hash}${RESET}`);
  console.log(`   ${GREEN}└${"─".repeat(53)}┘${RESET}`);
}

async function withProgressBar<T>(label: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`   ${label}\n   `);

  const width = 40;
  let position = 0;
  const startTime = Date.now();

  const interval = setInterval(() => {
    position = Math.min(position + 1, width - 1);
    const filled = "█".repeat(position);
    const empty = "░".repeat(width - position);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stdout.write(`\r   ${GREEN}${filled}${DIM}${empty}${RESET} ${elapsed}s`);
  }, 150);

  try {
    const result = await fn();
    clearInterval(interval);
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stdout.write(`\r   ${GREEN}${"█".repeat(width)}${RESET} ${totalTime}s ${GREEN}Done${RESET}\n`);
    return result;
  } catch (error) {
    clearInterval(interval);
    process.stdout.write(`\r   ${RED}${"█".repeat(position)}${"░".repeat(width - position)} FAILED${RESET}\n`);
    throw error;
  }
}

// ============================================================================
// Simulated 402 Response
// ============================================================================

function simulate402Response() {
  return {
    status: 402,
    headers: {
      "X-Payment-Required": "true",
      "X-Payment-Scheme": "fhe-confidential-v1",
      "X-Payment-Token": TOKEN_ADDRESS,
      "X-Payment-Verifier": VERIFIER_ADDRESS,
      "X-Payment-Amount": "500000", // 0.50 USDC in raw
      "X-Payment-Network": "eip155:11155111",
    },
    body: {
      error: "Payment Required",
      accepts: {
        scheme: "fhe-confidential-v1",
        network: "eip155:11155111",
        maxAmountRequired: "500000",
        resource: "/api/v1/premium-data",
        description: "Premium market data endpoint",
        payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      },
    },
  };
}

// ============================================================================
// Main Demo
// ============================================================================

interface TxResult {
  phase: string;
  hash: string;
  gas: bigint;
}

async function main() {
  if (!process.env.PRIVATE_KEY) {
    console.error(`${RED}ERROR: Set PRIVATE_KEY environment variable${RESET}`);
    console.error("Usage: PRIVATE_KEY=0x... npx tsx demo/marc-virtuals-agent.ts");
    process.exit(1);
  }

  const rpcUrl = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
  const provider = new JsonRpcProvider(rpcUrl);
  const signer = new Wallet(process.env.PRIVATE_KEY, provider);
  const address = await signer.getAddress();

  const usdc = new Contract(USDC_ADDRESS, USDC_ABI, signer);
  const token = new Contract(TOKEN_ADDRESS, TOKEN_ABI, signer);
  const verifier = new Contract(VERIFIER_ADDRESS, VERIFIER_ABI, signer);

  const txResults: TxResult[] = [];

  // ── HEADER ──
  printHeader();
  await sleep(1000);

  // ════════════════════════════════════════════════════════════
  // PHASE 1: Agent Initialization
  // ════════════════════════════════════════════════════════════

  printPhase(1, "AGENT INITIALIZATION");

  gameLog("GameWorker.init", "Starting FHE x402 Payment Worker");
  await sleep(500);

  agentLog("Connecting to Ethereum Sepolia...");
  await sleep(300);

  const ethBal = await provider.getBalance(address);
  const usdcBal: bigint = await usdc.balanceOf(address);
  const tokenName = await token.name();
  const tokenSymbol = await token.symbol();

  agentLog(`Wallet: ${CYAN}${address.slice(0, 12)}...${address.slice(-8)}${RESET}`);
  agentLog(`ETH:    ${GREEN}${parseFloat(formatUnits(ethBal, 18)).toFixed(4)}${RESET}`);
  agentLog(`USDC:   ${GREEN}${formatUnits(usdcBal, 6)}${RESET}`);
  agentLog(`Token:  ${tokenName} (${tokenSymbol})`);
  agentLog(`Scheme: fhe-confidential-v1`);
  await sleep(300);

  gameLog("fhe_info", `${GREEN}Done${RESET} — Worker ready`);
  gameLog("fhe_balance", `USDC: ${formatUnits(usdcBal, 6)}, cUSDC: checking...`);

  const encHandle = await token.confidentialBalanceOf(address);
  const zeroHandle = "0x" + "00".repeat(32);
  const hasEncBal = encHandle !== zeroHandle;
  gameLog("fhe_balance", `cUSDC handle: ${hasEncBal ? YELLOW + "non-zero" + RESET : DIM + "none" + RESET}`);

  // Mint if needed
  if (usdcBal < parseUnits("2", 6)) {
    agentLog(`${YELLOW}Low USDC balance — minting 10 test USDC...${RESET}`);
    const mintTx = await usdc.mint(address, parseUnits("10", 6));
    await mintTx.wait();
    agentLog(`${GREEN}Minted 10 USDC${RESET}`);
  }

  await sleep(1000);

  // ════════════════════════════════════════════════════════════
  // PHASE 2: HTTP 402 Discovery
  // ════════════════════════════════════════════════════════════

  printPhase(2, "HTTP 402 PAYWALL DISCOVERY");

  agentLog(`Requesting ${CYAN}GET /api/v1/premium-data${RESET}...`);
  await sleep(800);

  const resp402 = simulate402Response();

  serverLog(`${RED}${BOLD}HTTP 402 Payment Required${RESET}`);
  await sleep(300);

  // Display 402 response
  console.log("");
  console.log(`   ${YELLOW}┌─── HTTP RESPONSE ─────────────────────────────┐${RESET}`);
  console.log(`   ${YELLOW}│${RESET} Status: ${RED}${BOLD}402 Payment Required${RESET}`);
  console.log(`   ${YELLOW}│${RESET} Scheme: ${CYAN}fhe-confidential-v1${RESET}`);
  console.log(`   ${YELLOW}│${RESET} Token:  ${DIM}${TOKEN_ADDRESS.slice(0, 16)}...${RESET}`);
  console.log(`   ${YELLOW}│${RESET} Amount: ${BOLD}0.50 USDC${RESET} (encrypted)`);
  console.log(`   ${YELLOW}│${RESET} PayTo:  ${DIM}${resp402.body.accepts.payTo.slice(0, 16)}...${RESET}`);
  console.log(`   ${YELLOW}│${RESET} Resource: /api/v1/premium-data`);
  console.log(`   ${YELLOW}└───────────────────────────────────────────────┘${RESET}`);
  console.log("");

  agentLog("Detected x402 paywall — FHE payment required");
  agentLog(`Parsing requirements: ${CYAN}0.50 USDC${RESET} to ${resp402.body.accepts.payTo.slice(0, 12)}...`);
  await sleep(500);

  gameLog("decision", `${YELLOW}Need cUSDC balance → calling fhe_wrap first${RESET}`);

  await sleep(1000);

  // ════════════════════════════════════════════════════════════
  // PHASE 3: fhe_wrap — USDC → cUSDC
  // ════════════════════════════════════════════════════════════

  printPhase(3, "fhe_wrap — CONVERT USDC → ENCRYPTED cUSDC");

  gameLog("fhe_wrap", `amount=1.00 USDC`);
  await sleep(300);

  agentLog("Approving ConfidentialUSDC contract...");
  const wrapAmount = parseUnits("1", 6);
  const approveTx = await usdc.approve(TOKEN_ADDRESS, wrapAmount);
  await approveTx.wait();
  agentLog(`Approval confirmed`);

  const wrapResult = await withProgressBar("Wrapping 1.00 USDC → cUSDC (ERC-7984)...", async () => {
    const tx = await token.wrap(address, wrapAmount);
    return tx.wait();
  });

  console.log("");
  printTxBox(wrapResult.hash, wrapResult.gasUsed, "fhe_wrap");
  console.log("");

  gameLog("fhe_wrap", `${GREEN}Done${RESET} — 1.00 USDC wrapped (0.1% fee deducted)`);

  txResults.push({ phase: "fhe_wrap", hash: wrapResult.hash, gas: wrapResult.gasUsed });

  await sleep(1000);

  // ════════════════════════════════════════════════════════════
  // PHASE 4: fhe_pay — FHE Encrypted Payment
  // ════════════════════════════════════════════════════════════

  printPhase(4, "fhe_pay — FHE ENCRYPTED PAYMENT");

  const payTo = resp402.body.accepts.payTo;
  const payAmount = parseUnits("0.50", 6);
  const nonce = ethers.hexlify(ethers.randomBytes(32));

  gameLog("fhe_pay", `to=${payTo.slice(0, 12)}..., amount=0.50 USDC`);
  await sleep(300);

  // Init FHE
  agentLog("Initializing Zama FHE encryption engine...");
  const fhevmInstance = await withProgressBar("Loading @zama-fhe/relayer-sdk...", async () => {
    return createInstance({ ...SepoliaConfig, network: rpcUrl });
  });

  agentLog(`${GREEN}FHE engine ready${RESET}`);
  await sleep(300);

  // Encrypt + Transfer
  agentLog("Creating encrypted input (FHE.add64)...");
  const transferResult = await withProgressBar("Encrypting 0.50 USDC + confidentialTransfer...", async () => {
    const input = fhevmInstance.createEncryptedInput(TOKEN_ADDRESS, address);
    input.add64(payAmount);
    const encrypted = await input.encrypt();

    const tx = await token.confidentialTransfer(
      payTo,
      encrypted.handles[0],
      encrypted.inputProof,
    );
    return tx.wait();
  });

  console.log("");
  printTxBox(transferResult.hash, transferResult.gasUsed, "confidentialTransfer");
  console.log("");

  agentLog(`Transfer complete — amount is ${GREEN}${BOLD}ENCRYPTED${RESET} on-chain`);
  await sleep(500);

  // Record nonce
  agentLog("Recording payment nonce on X402PaymentVerifier...");
  const nonceResult = await withProgressBar("recordPayment (x402 nonce)...", async () => {
    const tx = await verifier.recordPayment(payTo, nonce, payAmount);
    return tx.wait();
  });

  console.log("");
  printTxBox(nonceResult.hash, nonceResult.gasUsed, "recordPayment");
  console.log("");

  gameLog("fhe_pay", `${GREEN}Done${RESET} — 2-TX flow complete (transfer + nonce)`);

  txResults.push(
    { phase: "confidentialTransfer", hash: transferResult.hash, gas: transferResult.gasUsed },
    { phase: "recordPayment", hash: nonceResult.hash, gas: nonceResult.gasUsed },
  );

  await sleep(1000);

  // ════════════════════════════════════════════════════════════
  // PHASE 5: Server Verification → 200 OK
  // ════════════════════════════════════════════════════════════

  printPhase(5, "SERVER VERIFICATION → ACCESS GRANTED");

  agentLog(`Sending payment proof to server...`);
  agentLog(`  nonce:  ${nonce.slice(0, 22)}...`);
  agentLog(`  txHash: ${transferResult.hash.slice(0, 22)}...`);
  await sleep(800);

  serverLog("Received payment proof");
  serverLog(`Checking nonce on X402PaymentVerifier...`);
  await sleep(500);

  const isUsed = await verifier.usedNonces(nonce);
  serverLog(`Nonce verified: ${isUsed ? GREEN + "USED" + RESET : RED + "NOT FOUND" + RESET}`);
  await sleep(300);

  serverLog(`Verifying confidentialTransfer on ConfidentialUSDC...`);
  await sleep(500);

  // Simulated server response
  console.log("");
  console.log(`   ${GREEN}${BOLD}┌─── HTTP RESPONSE ─────────────────────────────┐${RESET}`);
  console.log(`   ${GREEN}${BOLD}│${RESET} Status: ${GREEN}${BOLD}200 OK${RESET}`);
  console.log(`   ${GREEN}${BOLD}│${RESET}`);
  console.log(`   ${GREEN}${BOLD}│${RESET} ${WHITE}${BOLD}{${RESET}`);
  console.log(`   ${GREEN}${BOLD}│${RESET}   ${CYAN}"data"${RESET}: ${DIM}"Premium market analysis..."${RESET},`);
  console.log(`   ${GREEN}${BOLD}│${RESET}   ${CYAN}"paid"${RESET}: ${GREEN}true${RESET},`);
  console.log(`   ${GREEN}${BOLD}│${RESET}   ${CYAN}"scheme"${RESET}: ${YELLOW}"fhe-confidential-v1"${RESET},`);
  console.log(`   ${GREEN}${BOLD}│${RESET}   ${CYAN}"amountVisible"${RESET}: ${RED}false${RESET}`);
  console.log(`   ${GREEN}${BOLD}│${RESET} ${WHITE}${BOLD}}${RESET}`);
  console.log(`   ${GREEN}${BOLD}└───────────────────────────────────────────────┘${RESET}`);
  console.log("");

  agentLog(`${GREEN}${BOLD}ACCESS GRANTED${RESET} — premium data received`);
  gameLog("decision", `${GREEN}Payment successful — task complete${RESET}`);

  await sleep(1000);

  // ════════════════════════════════════════════════════════════
  // PHASE 6: Post-Payment Summary
  // ════════════════════════════════════════════════════════════

  printPhase(6, "POST-PAYMENT STATUS");

  gameLog("fhe_balance", "Checking updated balance...");

  const newUsdcBal: bigint = await usdc.balanceOf(address);
  const newEncHandle = await token.confidentialBalanceOf(address);
  const hasNewEncBal = newEncHandle !== zeroHandle;

  agentLog(`Public USDC:    ${GREEN}${formatUnits(newUsdcBal, 6)}${RESET}`);
  agentLog(`Encrypted cUSDC: ${hasNewEncBal ? YELLOW + "Active handle" + RESET : DIM + "None" + RESET}`);

  gameLog("fhe_balance", `${GREEN}Done${RESET}`);

  // Summary table
  console.log("");
  console.log(`   ${BOLD}┌─────────────────────────────┬──────────────┐${RESET}`);
  console.log(`   ${BOLD}│ GameFunction                │ Gas Used     │${RESET}`);
  console.log(`   ${BOLD}├─────────────────────────────┼──────────────┤${RESET}`);
  for (const tx of txResults) {
    console.log(`   │ ${tx.phase.padEnd(27)} │ ${YELLOW}${tx.gas.toLocaleString().padStart(12)}${RESET} │`);
  }
  const totalGas = txResults.reduce((sum, tx) => sum + tx.gas, 0n);
  console.log(`   ${BOLD}├─────────────────────────────┼──────────────┤${RESET}`);
  console.log(`   ${BOLD}│ TOTAL                       │ ${GREEN}${totalGas.toLocaleString().padStart(12)}${RESET} ${BOLD}│${RESET}`);
  console.log(`   ${BOLD}└─────────────────────────────┴──────────────┘${RESET}`);

  // Virtuals integration summary
  console.log("");
  console.log(`   ${BOLD}Virtuals GAME Integration:${RESET}`);
  console.log(`   ${DIM}├${RESET} GameWorker: ${CYAN}FHE x402 Payment Worker${RESET}`);
  console.log(`   ${DIM}├${RESET} Functions:  fhe_wrap, fhe_pay, fhe_unwrap, fhe_balance, fhe_info`);
  console.log(`   ${DIM}├${RESET} Decisions:  Autonomous (detect 402 → wrap → pay → access)`);
  console.log(`   ${DIM}└${RESET} Protocol:   ${CYAN}MARC (fhe-confidential-v1)${RESET}`);

  // Final banner
  console.log("");
  console.log(`${CYAN}${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${CYAN}${BOLD}║  ${GREEN}Autonomous agent completed x402 payment cycle.${CYAN}          ║${RESET}`);
  console.log(`${CYAN}${BOLD}║  402 Detected → Wrap → FHE Pay → 200 OK                  ║${RESET}`);
  console.log(`${CYAN}${BOLD}║  All amounts encrypted — server can't see balances.       ║${RESET}`);
  console.log(`${CYAN}${BOLD}║  github.com/Himess/marc-protocol                          ║${RESET}`);
  console.log(`${CYAN}${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log("");
}

main().catch((error) => {
  console.error(`\n${RED}Demo failed: ${error.message}${RESET}`);
  console.error(`${DIM}${error.stack}${RESET}`);
  process.exit(1);
});
