/**
 * MARC Protocol — Full Agent Lifecycle Demo
 *
 * Video-ready terminal demo with real on-chain transactions on Ethereum Sepolia.
 * Shows the complete 6-step agent lifecycle:
 *   Step 1: Register Agent Identity (ERC-8004)
 *   Step 2: Wrap USDC → cUSDC (ERC-7984)
 *   Step 3: FHE Encrypt + Confidential Transfer
 *   Step 4: Record Payment Nonce (x402)
 *   Step 5: Give Feedback (ERC-8004 Reputation)
 *   Step 6: Privacy & Gas Summary
 *
 * Usage: PRIVATE_KEY=0x... npx tsx demo/marc-agent-lifecycle.ts
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

// ============================================================================
// Contract Addresses (Sepolia V4.3)
// ============================================================================

const USDC_ADDRESS = "0xc89e913676B034f8b38E49f7508803d1cDEC9F4f";
const TOKEN_ADDRESS = "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D";
const VERIFIER_ADDRESS = "0x4503A7aee235aBD10e6064BBa8E14235fdF041f4";
const IDENTITY_ADDRESS = "0xf4609D5DB3153717827703C795acb00867b69567";
const REPUTATION_ADDRESS = "0xd1Dd10990f317802c79077834c75742388959668";

const ETHERSCAN = "https://sepolia.etherscan.io";

// ============================================================================
// ABIs
// ============================================================================

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
  "function paused() view returns (bool)",
];

const VERIFIER_ABI = [
  "function recordPayment(address server, bytes32 nonce, uint64 minPrice) external",
  "function usedNonces(bytes32) view returns (bool)",
  "event PaymentVerified(address indexed payer, address indexed server, bytes32 indexed nonce, uint64 minPrice)",
];

const IDENTITY_ABI = [
  "function register(string calldata agentURI) external returns (uint256)",
  "function getAgent(uint256 agentId) external view returns (string memory uri, address owner, address wallet)",
  "function agentOf(address wallet) external view returns (uint256)",
  "event AgentRegistered(uint256 indexed agentId, address indexed owner, string agentURI)",
];

const REPUTATION_ABI = [
  "function giveFeedback(uint256 agentId, uint8 score, bytes32[] calldata tags, bytes calldata proofOfPayment) external",
  "function getSummary(uint256 agentId) external view returns (uint256 totalFeedback, uint256 averageScore, uint256 lastUpdated)",
  "event FeedbackGiven(uint256 indexed agentId, address indexed reviewer, uint8 score)",
];

// ============================================================================
// Display Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHeader() {
  console.log("");
  console.log(`${CYAN}${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${CYAN}${BOLD}║  MARC Protocol — Full Agent Lifecycle Demo               ║${RESET}`);
  console.log(`${CYAN}${BOLD}║  Modular Agent-Ready Confidential Protocol                ║${RESET}`);
  console.log(`${CYAN}${BOLD}║  Network: Ethereum Sepolia (11155111)                     ║${RESET}`);
  console.log(`${CYAN}${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);
}

function printSeparator() {
  console.log(`\n${DIM}────────────────────────────────────────────────────────────${RESET}`);
}

function printStep(step: number, title: string) {
  console.log(`\n${BOLD}${BLUE}  ▶ STEP ${step}: ${title}${RESET}\n`);
}

function printTxBox(hash: string, gasUsed: bigint, label?: string) {
  const shortHash = `${hash.slice(0, 14)}...${hash.slice(-10)}`;
  const link = `${ETHERSCAN}/tx/${hash}`;
  console.log(`   ${GREEN}┌─── ${label || "TRANSACTION"} ${"─".repeat(Math.max(0, 40 - (label?.length || 11)))}┐${RESET}`);
  console.log(`   ${GREEN}│${RESET} TX:   ${CYAN}${shortHash}${RESET}`);
  console.log(`   ${GREEN}│${RESET} Gas:  ${YELLOW}${gasUsed.toLocaleString()}${RESET}`);
  console.log(`   ${GREEN}│${RESET} View: ${DIM}${link}${RESET}`);
  console.log(`   ${GREEN}└${"─".repeat(53)}┘${RESET}`);
}

function printInfo(label: string, value: string) {
  console.log(`   ${DIM}${label.padEnd(18)}${RESET} ${value}`);
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
// Main Demo
// ============================================================================

interface TxResult {
  step: string;
  hash: string;
  gas: bigint;
}

async function main() {
  // ENV
  if (!process.env.PRIVATE_KEY) {
    console.error(`${RED}ERROR: Set PRIVATE_KEY environment variable${RESET}`);
    console.error("Usage: PRIVATE_KEY=0x... npx tsx demo/marc-agent-lifecycle.ts");
    process.exit(1);
  }

  const rpcUrl = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
  const provider = new JsonRpcProvider(rpcUrl);
  const signer = new Wallet(process.env.PRIVATE_KEY, provider);
  const address = await signer.getAddress();

  const usdc = new Contract(USDC_ADDRESS, USDC_ABI, signer);
  const token = new Contract(TOKEN_ADDRESS, TOKEN_ABI, signer);
  const verifier = new Contract(VERIFIER_ADDRESS, VERIFIER_ABI, signer);
  const identity = new Contract(IDENTITY_ADDRESS, IDENTITY_ABI, signer);
  const reputation = new Contract(REPUTATION_ADDRESS, REPUTATION_ABI, signer);

  const txResults: TxResult[] = [];

  // ── HEADER ──
  printHeader();

  const ethBal = await provider.getBalance(address);
  const usdcBal: bigint = await usdc.balanceOf(address);

  console.log("");
  printInfo("Agent Wallet", address);
  printInfo("ETH Balance", `${parseFloat(formatUnits(ethBal, 18)).toFixed(4)} ETH`);
  printInfo("USDC Balance", `${formatUnits(usdcBal, 6)} USDC`);
  printInfo("Scheme", "fhe-confidential-v1");

  console.log("");
  printInfo("ConfidentialUSDC", TOKEN_ADDRESS);
  printInfo("PaymentVerifier", VERIFIER_ADDRESS);
  printInfo("IdentityRegistry", IDENTITY_ADDRESS);
  printInfo("ReputationReg", REPUTATION_ADDRESS);

  // Mint USDC if needed
  if (usdcBal < parseUnits("2", 6)) {
    console.log(`\n   ${YELLOW}Minting 10 test USDC...${RESET}`);
    const mintTx = await usdc.mint(address, parseUnits("10", 6));
    await mintTx.wait();
    console.log(`   ${GREEN}Minted 10 USDC${RESET}`);
  }

  await sleep(1500);

  // ════════════════════════════════════════════════════════════
  // STEP 1: Register Agent Identity (ERC-8004)
  // ════════════════════════════════════════════════════════════

  printSeparator();
  printStep(1, "Register Agent Identity (ERC-8004)");

  const agentURI = JSON.stringify({
    name: "MARC-Demo-Agent",
    version: "1.0.0",
    x402Support: true,
    scheme: "fhe-confidential-v1",
    services: ["data-analysis", "content-generation"],
    network: "eip155:11155111",
  });

  printInfo("Agent URI", `${agentURI.slice(0, 50)}...`);

  const registerResult = await withProgressBar("Registering agent on-chain...", async () => {
    const tx = await identity.register(agentURI);
    return tx.wait();
  });

  // Parse agentId from event
  const registerLog = registerResult.logs.find(
    (log: any) => log.address.toLowerCase() === IDENTITY_ADDRESS.toLowerCase()
  );
  const iface = new ethers.Interface(IDENTITY_ABI);
  let agentId = 0n;
  if (registerLog) {
    try {
      const parsed = iface.parseLog({ topics: registerLog.topics as string[], data: registerLog.data });
      agentId = parsed?.args[0] ?? 0n;
    } catch { /* fallback */ }
  }

  console.log(`\n   ${GREEN}${BOLD}AGENT REGISTERED${RESET}`);
  printTxBox(registerResult.hash, registerResult.gasUsed, "IDENTITY REGISTRATION");
  printInfo("Agent ID", `#${agentId.toString()}`);
  printInfo("Standard", "ERC-8004");

  txResults.push({ step: "Register Identity", hash: registerResult.hash, gas: registerResult.gasUsed });

  await sleep(1500);

  // ════════════════════════════════════════════════════════════
  // STEP 2: Wrap USDC → cUSDC (ERC-7984)
  // ════════════════════════════════════════════════════════════

  printSeparator();
  printStep(2, "Wrap USDC → Encrypted cUSDC (ERC-7984)");

  const wrapAmount = parseUnits("1", 6); // 1 USDC
  const feesBefore: bigint = await token.accumulatedFees();

  printInfo("Amount", "1.00 USDC");
  printInfo("Fee", "0.1% (min 0.01 USDC)");

  // Approve
  process.stdout.write(`   Approving ConfidentialUSDC...          `);
  const approveTx = await usdc.approve(TOKEN_ADDRESS, wrapAmount);
  await approveTx.wait();
  console.log(`${GREEN}Done${RESET}`);

  const wrapResult = await withProgressBar("Wrapping USDC into encrypted cUSDC...", async () => {
    const tx = await token.wrap(address, wrapAmount);
    return tx.wait();
  });

  const feesAfter: bigint = await token.accumulatedFees();
  const feeCollected = feesAfter - feesBefore;

  console.log(`\n   ${GREEN}${BOLD}WRAP COMPLETE${RESET}`);
  printTxBox(wrapResult.hash, wrapResult.gasUsed, "WRAP USDC → cUSDC");
  printInfo("Gross", "1.00 USDC");
  printInfo("Fee", `${formatUnits(feeCollected, 6)} USDC`);
  printInfo("Net cUSDC", `${formatUnits(wrapAmount - feeCollected, 6)} (encrypted)`);
  printInfo("Standard", "ERC-7984 (Confidential Token)");

  txResults.push({ step: "Wrap USDC→cUSDC", hash: wrapResult.hash, gas: wrapResult.gasUsed });

  await sleep(1500);

  // ════════════════════════════════════════════════════════════
  // STEP 3: FHE Encrypt + Confidential Transfer
  // ════════════════════════════════════════════════════════════

  printSeparator();
  printStep(3, "FHE Encrypt + Confidential Transfer");

  const serverAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const payAmount = parseUnits("0.50", 6); // 0.50 USDC

  printInfo("Recipient (Server)", `${serverAddress.slice(0, 12)}...${serverAddress.slice(-8)}`);
  printInfo("Amount", "0.50 USDC");
  printInfo("Encryption", "FHE (Zama fhEVM)");

  // Initialize FHE
  const fhevmInstance = await withProgressBar("Initializing FHE encryption engine...", async () => {
    return createInstance({ ...SepoliaConfig, network: rpcUrl });
  });

  // Create encrypted input
  const transferResult = await withProgressBar("Encrypting amount + submitting on-chain...", async () => {
    const input = fhevmInstance.createEncryptedInput(TOKEN_ADDRESS, address);
    input.add64(payAmount);
    const encrypted = await input.encrypt();

    const tx = await token.confidentialTransfer(
      serverAddress,
      encrypted.handles[0],
      encrypted.inputProof,
    );
    return tx.wait();
  });

  console.log(`\n   ${GREEN}${BOLD}CONFIDENTIAL TRANSFER COMPLETE${RESET}`);
  printTxBox(transferResult.hash, transferResult.gasUsed, "FHE ENCRYPTED TRANSFER");
  printInfo("Amount on-chain", `${RED}ENCRYPTED${RESET} (not visible)`);
  printInfo("Balance on-chain", `${RED}ENCRYPTED${RESET} (not visible)`);
  printInfo("Gas", `${transferResult.gasUsed.toLocaleString()} (constant regardless of amount)`);

  txResults.push({ step: "FHE Transfer", hash: transferResult.hash, gas: transferResult.gasUsed });

  await sleep(1500);

  // ════════════════════════════════════════════════════════════
  // STEP 4: Record Payment Nonce (x402)
  // ════════════════════════════════════════════════════════════

  printSeparator();
  printStep(4, "Record Payment Nonce (x402 Protocol)");

  const nonce = ethers.hexlify(ethers.randomBytes(32));

  printInfo("Nonce", `${nonce.slice(0, 22)}...`);
  printInfo("Protocol", "x402 (HTTP 402 Payment Required)");
  printInfo("Min Price", "0.50 USDC");

  const nonceResult = await withProgressBar("Recording payment nonce on-chain...", async () => {
    const tx = await verifier.recordPayment(serverAddress, nonce, payAmount);
    return tx.wait();
  });

  const isUsed = await verifier.usedNonces(nonce);

  console.log(`\n   ${GREEN}${BOLD}NONCE RECORDED${RESET}`);
  printTxBox(nonceResult.hash, nonceResult.gasUsed, "x402 PAYMENT NONCE");
  printInfo("Nonce Used", isUsed ? `${GREEN}Yes (replay prevented)${RESET}` : "No");
  printInfo("2-TX Flow", "confidentialTransfer + recordPayment");

  txResults.push({ step: "Record Nonce", hash: nonceResult.hash, gas: nonceResult.gasUsed });

  await sleep(1500);

  // ════════════════════════════════════════════════════════════
  // STEP 5: Give Feedback (ERC-8004 Reputation)
  // ════════════════════════════════════════════════════════════

  printSeparator();
  printStep(5, "Give Feedback (ERC-8004 Reputation)");

  const feedbackScore = 9; // out of 10
  const tags = [
    ethers.encodeBytes32String("reliable"),
    ethers.encodeBytes32String("fast"),
    ethers.encodeBytes32String("accurate"),
  ];
  const proofOfPayment = ethers.toUtf8Bytes(JSON.stringify({
    txHash: transferResult.hash,
    nonce,
    amount: "0.50",
  }));

  printInfo("Agent ID", `#${agentId.toString()}`);
  printInfo("Score", `${feedbackScore}/10`);
  printInfo("Tags", "reliable, fast, accurate");

  const feedbackResult = await withProgressBar("Submitting on-chain feedback...", async () => {
    const tx = await reputation.giveFeedback(agentId, feedbackScore, tags, proofOfPayment);
    return tx.wait();
  });

  // Fetch updated summary
  const [totalFeedback, averageScore] = await reputation.getSummary(agentId);

  console.log(`\n   ${GREEN}${BOLD}FEEDBACK SUBMITTED${RESET}`);
  printTxBox(feedbackResult.hash, feedbackResult.gasUsed, "REPUTATION FEEDBACK");
  printInfo("Total Feedback", totalFeedback.toString());
  printInfo("Average Score", `${averageScore.toString()}/10`);
  printInfo("Standard", "ERC-8004 (Agent Reputation)");

  txResults.push({ step: "Give Feedback", hash: feedbackResult.hash, gas: feedbackResult.gasUsed });

  await sleep(1500);

  // ════════════════════════════════════════════════════════════
  // STEP 6: Privacy & Gas Summary
  // ════════════════════════════════════════════════════════════

  printSeparator();
  console.log("");
  console.log(`${CYAN}${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${CYAN}${BOLD}║  PRIVACY ANALYSIS                                        ║${RESET}`);
  console.log(`${CYAN}${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);

  // Privacy comparison table
  console.log(`
   ${BOLD}WHAT AGENTS KNOW:${RESET}              ${BOLD}WHAT CHAIN SHOWS:${RESET}
   ${DIM}──────────────────${RESET}             ${DIM}──────────────────${RESET}
   Agent paid 0.50 USDC          TX1: confidentialTransfer(...)
   Balance: ~0.49 cUSDC          TX2: recordPayment(nonce)
   Score: 9/10                   ${DIM}(amounts are FHE-encrypted)${RESET}
`);

  console.log(`   ${BOLD}┌────────────────────┬────────────┬──────────────┐${RESET}`);
  console.log(`   ${BOLD}│ Property           │ Normal ERC20│ MARC (FHE)   │${RESET}`);
  console.log(`   ${BOLD}├────────────────────┼────────────┼──────────────┤${RESET}`);
  console.log(`   │ Transfer Amount    │ ${RED}  PUBLIC   ${RESET}│ ${GREEN} ENCRYPTED  ${RESET}│`);
  console.log(`   │ Balance            │ ${RED}  PUBLIC   ${RESET}│ ${GREEN} ENCRYPTED  ${RESET}│`);
  console.log(`   │ TX Success/Fail    │ ${RED}  PUBLIC   ${RESET}│ ${GREEN} HIDDEN*    ${RESET}│`);
  console.log(`   │ Sender Address     │ ${RED}  PUBLIC   ${RESET}│ ${YELLOW} PUBLIC**   ${RESET}│`);
  console.log(`   │ Recipient Address  │ ${RED}  PUBLIC   ${RESET}│ ${YELLOW} PUBLIC**   ${RESET}│`);
  console.log(`   ${BOLD}└────────────────────┴────────────┴──────────────┘${RESET}`);
  console.log(`   ${DIM}*  Silent failure: insufficient balance → transfers 0, no revert${RESET}`);
  console.log(`   ${DIM}** x402 requires public participants for payment verification${RESET}`);

  // Gas summary
  console.log("");
  console.log(`   ${BOLD}┌───────────────────────────┬──────────────┐${RESET}`);
  console.log(`   ${BOLD}│ Operation                 │ Gas Used     │${RESET}`);
  console.log(`   ${BOLD}├───────────────────────────┼──────────────┤${RESET}`);
  for (const tx of txResults) {
    console.log(`   │ ${tx.step.padEnd(25)} │ ${YELLOW}${tx.gas.toLocaleString().padStart(12)}${RESET} │`);
  }
  const totalGas = txResults.reduce((sum, tx) => sum + tx.gas, 0n);
  console.log(`   ${BOLD}├───────────────────────────┼──────────────┤${RESET}`);
  console.log(`   ${BOLD}│ TOTAL                     │ ${GREEN}${totalGas.toLocaleString().padStart(12)}${RESET} ${BOLD}│${RESET}`);
  console.log(`   ${BOLD}└───────────────────────────┴──────────────┘${RESET}`);

  // Transaction links
  console.log("");
  console.log(`${CYAN}${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${CYAN}${BOLD}║  VERIFY ON ETHERSCAN                                     ║${RESET}`);
  console.log(`${CYAN}${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log("");

  for (const tx of txResults) {
    console.log(`   ${BOLD}${tx.step}:${RESET}`);
    console.log(`   ${DIM}${ETHERSCAN}/tx/${tx.hash}${RESET}`);
    console.log("");
  }

  // Final banner
  console.log(`${CYAN}${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${CYAN}${BOLD}║  ${GREEN}All ${txResults.length} transactions completed successfully.${CYAN}             ║${RESET}`);
  console.log(`${CYAN}${BOLD}║  Protocol: MARC (Modular Agent-Ready Confidential)       ║${RESET}`);
  console.log(`${CYAN}${BOLD}║  Standards: ERC-7984 + ERC-8004 + ERC-8183 + x402        ║${RESET}`);
  console.log(`${CYAN}${BOLD}║  github.com/Himess/marc-protocol                         ║${RESET}`);
  console.log(`${CYAN}${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log("");
}

main().catch((error) => {
  console.error(`\n${RED}Demo failed: ${error.message}${RESET}`);
  console.error(`${DIM}${error.stack}${RESET}`);
  process.exit(1);
});
