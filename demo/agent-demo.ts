/**
 * FHE x402 Agent Demo — Terminal demonstration with ANSI colors.
 *
 * Shows the full flow:
 *   Step 1: Deposit USDC into FHE pool
 *   Step 2: Encrypted payment to another agent (real fhevmjs encryption)
 *   Step 3: Check balance status
 *   Step 4: Request withdrawal (real fhevmjs encryption)
 *
 * Usage: npx tsx demo/agent-demo.ts
 * Requires: PRIVATE_KEY env var + funded Sepolia account
 */

import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits, ethers } from "ethers";
import { initFhevm, createInstance } from "fhevmjs";
import { POOL_ABI } from "fhe-x402-sdk";

// ============================================================================
// ANSI Colors
// ============================================================================

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

const POOL_ADDRESS = "0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73";
const USDC_ADDRESS = "0x229146B746cf3A314dee33f08b84f8EFd5F314F4";
const GATEWAY_URL = "https://gateway.sepolia.zama.ai";

const USDC_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
];

// ============================================================================
// Helpers
// ============================================================================

function banner(text: string) {
  const line = "═".repeat(60);
  console.log(`\n${CYAN}╔${line}╗${RESET}`);
  console.log(`${CYAN}║${RESET} ${BOLD}${text.padEnd(58)}${RESET} ${CYAN}║${RESET}`);
  console.log(`${CYAN}╚${line}╝${RESET}\n`);
}

function step(n: number, text: string) {
  console.log(`${BOLD}${BLUE}[Step ${n}]${RESET} ${text}`);
}

function info(label: string, value: string) {
  console.log(`  ${DIM}${label}:${RESET} ${GREEN}${value}${RESET}`);
}

function txBox(hash: string, block: number) {
  console.log(`  ${YELLOW}┌─────────────────────────────────────────────────┐${RESET}`);
  console.log(`  ${YELLOW}│${RESET} TX: ${CYAN}${hash.slice(0, 20)}...${hash.slice(-8)}${RESET}${" ".repeat(Math.max(0, 11))}${YELLOW}│${RESET}`);
  console.log(`  ${YELLOW}│${RESET} Block: ${GREEN}${block}${RESET}${" ".repeat(Math.max(0, 40 - String(block).length))}${YELLOW}│${RESET}`);
  console.log(`  ${YELLOW}└─────────────────────────────────────────────────┘${RESET}`);
}

function progress(text: string) {
  process.stdout.write(`  ${DIM}${text}...${RESET}`);
}

function done() {
  console.log(` ${GREEN}done${RESET}`);
}

function separator() {
  console.log(`${DIM}${"─".repeat(62)}${RESET}`);
}

// ============================================================================
// Main Demo
// ============================================================================

async function main() {
  banner("FHE x402 Agent Payment Demo");

  console.log(`${MAGENTA}Scheme:${RESET}  fhe-confidential-v1`);
  console.log(`${MAGENTA}Network:${RESET} Ethereum Sepolia (chainId 11155111)`);
  console.log(`${MAGENTA}Pool:${RESET}    ${POOL_ADDRESS}`);
  console.log(`${MAGENTA}USDC:${RESET}    ${USDC_ADDRESS}`);
  separator();

  // Setup
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.log(`${RED}Error: PRIVATE_KEY env var is required${RESET}`);
    process.exit(1);
  }

  const rpcUrl = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
  const provider = new JsonRpcProvider(rpcUrl);
  const signer = new Wallet(privateKey, provider);
  const address = await signer.getAddress();

  const pool = new Contract(POOL_ADDRESS, POOL_ABI, signer);
  const usdc = new Contract(USDC_ADDRESS, USDC_ABI, signer);

  info("Agent Address", address);
  info("Network", "Ethereum Sepolia");

  // Initialize fhevmjs
  progress("Initializing fhevmjs (TFHE WASM)");
  await initFhevm();
  const fhevmInstance = await createInstance({
    chainId: 11155111,
    networkUrl: rpcUrl,
    gatewayUrl: GATEWAY_URL,
  });
  done();

  // Check balances
  const ethBal = await provider.getBalance(address);
  const usdcBal: bigint = await usdc.balanceOf(address);
  info("ETH Balance", formatUnits(ethBal, 18) + " ETH");
  info("USDC Balance", formatUnits(usdcBal, 6) + " USDC");
  separator();

  // =============================================
  // Step 1: Deposit
  // =============================================

  step(1, "Deposit USDC into FHE Pool");
  const depositAmount = parseUnits("1", 6); // 1 USDC

  progress("Approving USDC");
  const approveTx = await usdc.approve(POOL_ADDRESS, depositAmount);
  await approveTx.wait();
  done();

  progress("Depositing 1 USDC");
  const depositTx = await pool.deposit(depositAmount);
  const depositReceipt = await depositTx.wait();
  done();

  txBox(depositReceipt.hash, depositReceipt.blockNumber);
  info("Deposited", "1.00 USDC");
  info("Fee", "0.01 USDC (minimum)");
  info("Credited", "0.99 USDC (encrypted)");
  separator();

  // =============================================
  // Step 2: Encrypted Payment (real fhevmjs)
  // =============================================

  step(2, "Encrypted Payment to Recipient");
  const recipient = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const payAmount = parseUnits("0.5", 6); // 0.5 USDC

  console.log(`  ${DIM}Recipient: ${recipient}${RESET}`);
  console.log(`  ${DIM}Amount: 0.5 USDC (minPrice = public, encrypted amount = hidden)${RESET}`);

  progress("Encrypting amount with fhevmjs");
  const payInput = fhevmInstance.createEncryptedInput(POOL_ADDRESS, address);
  payInput.add64(payAmount);
  const payEncrypted = await payInput.encrypt();
  done();

  const nonce = ethers.hexlify(ethers.randomBytes(32));

  progress("Submitting encrypted payment");
  try {
    const payTx = await pool.pay(
      recipient,
      payEncrypted.handles[0],
      payEncrypted.inputProof,
      payAmount,
      nonce
    );
    const payReceipt = await payTx.wait();
    done();
    txBox(payReceipt.hash, payReceipt.blockNumber);
  } catch (e: any) {
    console.log(` ${RED}failed: ${e.message}${RESET}`);
  }

  // Privacy comparison
  console.log(`\n  ${BOLD}Privacy Comparison:${RESET}`);
  console.log(`  ┌──────────────────┬──────────────┬──────────────┐`);
  console.log(`  │ Property         │ Normal USDC  │ FHE x402     │`);
  console.log(`  ├──────────────────┼──────────────┼──────────────┤`);
  console.log(`  │ Amount           │ ${RED}Public${RESET}       │ ${GREEN}Encrypted${RESET}    │`);
  console.log(`  │ Sender           │ ${RED}Public${RESET}       │ ${YELLOW}Public*${RESET}      │`);
  console.log(`  │ Recipient        │ ${RED}Public${RESET}       │ ${YELLOW}Public*${RESET}      │`);
  console.log(`  │ Balance          │ ${RED}Public${RESET}       │ ${GREEN}Encrypted${RESET}    │`);
  console.log(`  │ TX Success       │ ${RED}Public${RESET}       │ ${GREEN}Hidden**${RESET}     │`);
  console.log(`  └──────────────────┴──────────────┴──────────────┘`);
  console.log(`  ${DIM}*  x402 requires public participants for payment verification${RESET}`);
  console.log(`  ${DIM}** Silent failure: insufficient balance → transfer 0, no revert${RESET}`);
  separator();

  // =============================================
  // Step 3: Check Balance
  // =============================================

  step(3, "Check Balance Status");

  const isInit = await pool.isInitialized(address);
  const newUsdcBal: bigint = await usdc.balanceOf(address);

  info("Pool Initialized", isInit ? "Yes" : "No");
  info("Public USDC", formatUnits(newUsdcBal, 6) + " USDC");
  info("Encrypted Balance", "(requires KMS decryption — not visible)");
  separator();

  // =============================================
  // Step 4: Request Withdrawal (real fhevmjs)
  // =============================================

  step(4, "Request Withdrawal (Step 1 of 2)");
  console.log(`  ${DIM}Note: Step 2 (finalize) requires async KMS callback.${RESET}`);
  console.log(`  ${DIM}This demo only executes step 1.${RESET}`);

  const withdrawAmount = parseUnits("0.1", 6); // 0.1 USDC

  progress("Encrypting withdrawal amount with fhevmjs");
  const wdInput = fhevmInstance.createEncryptedInput(POOL_ADDRESS, address);
  wdInput.add64(withdrawAmount);
  const wdEncrypted = await wdInput.encrypt();
  done();

  progress("Requesting withdrawal");
  try {
    const withdrawTx = await pool.requestWithdraw(
      wdEncrypted.handles[0],
      wdEncrypted.inputProof
    );
    const withdrawReceipt = await withdrawTx.wait();
    done();
    txBox(withdrawReceipt.hash, withdrawReceipt.blockNumber);
  } catch (e: any) {
    console.log(` ${RED}failed: ${e.message}${RESET}`);
  }

  separator();

  // Summary
  banner("Demo Complete");
  console.log(`  ${GREEN}All transactions on Ethereum Sepolia.${RESET}`);
  console.log(`  ${DIM}View on Etherscan: https://sepolia.etherscan.io/address/${address}${RESET}`);
  console.log();
}

main().catch((e) => {
  console.error(`${RED}Demo failed:${RESET}`, e.message);
  process.exit(1);
});
