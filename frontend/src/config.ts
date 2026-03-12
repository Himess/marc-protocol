// ============================================================================
// FHE x402 — Frontend Configuration
// ============================================================================

export const CHAIN_ID = 11155111;
export const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
export const ETHERSCAN_BASE = "https://sepolia.etherscan.io";

// ── Contract Addresses (Sepolia V4.3) ──────────────────────────────────────

export const ADDRESSES = {
  TOKEN: "0xE944754aa70d4924dc5d8E57774CDf21Df5e592D",
  VERIFIER: "0x4503A7aee235aBD10e6064BBa8E14235fdF041f4",
  USDC: "0xc89e913676B034f8b38E49f7508803d1cDEC9F4f",
  ACP: "0xBCA8d5ce6D57f36c7aF71954e9F7f86773a02F22",
  IDENTITY: "0xf4609D5DB3153717827703C795acb00867b69567",
  REPUTATION: "0xd1Dd10990f317802c79077834c75742388959668",
  TREASURY: "0xF505e2E71df58D7244189072008f25f6b6aaE5ae",
} as const;

// ── ABIs ────────────────────────────────────────────────────────────────────

export const TOKEN_ABI = [
  "function wrap(address to, uint256 amount) external",
  "function unwrap(address from, address to, bytes32 encryptedAmount, bytes calldata inputProof) external",
  "function confidentialTransfer(address to, bytes32 encryptedAmount, bytes calldata inputProof) external returns (bytes32)",
  "function confidentialBalanceOf(address account) external view returns (bytes32)",
  "function paused() external view returns (bool)",
  "function accumulatedFees() external view returns (uint256)",
  "function treasuryWithdraw() external",
  "function rate() external view returns (uint256)",
  "event ConfidentialTransfer(address indexed from, address indexed to, bytes32 indexed amount)",
];

export const VERIFIER_ABI = [
  "function recordPayment(address server, bytes32 nonce, uint64 minPrice) external",
  "function recordBatchPayment(address server, bytes32 nonce, uint64 totalAmount, uint32 requestCount, uint64 pricePerRequest) external",
  "function usedNonces(bytes32 nonce) external view returns (bool)",
  "event PaymentRecorded(address indexed payer, address indexed server, bytes32 indexed nonce, uint64 minPrice)",
  "event BatchPaymentRecorded(address indexed payer, address indexed server, bytes32 indexed nonce, uint64 totalAmount, uint32 requestCount)",
];

export const USDC_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
];

export const ACP_ABI = [
  "function createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook) external returns (uint256)",
  "function setProvider(uint256 jobId, address provider) external",
  "function setBudget(uint256 jobId, uint256 amount) external",
  "function fund(uint256 jobId, uint256 expectedBudget) external",
  "function submit(uint256 jobId, bytes32 deliverable) external",
  "function complete(uint256 jobId, bytes32 reason) external",
  "function reject(uint256 jobId, bytes32 reason) external",
  "function claimRefund(uint256 jobId) external",
  "function getJob(uint256 jobId) external view returns (tuple(address client, address provider, address evaluator, string description, uint256 budget, uint256 expiredAt, uint8 status, address hook, bytes32 deliverable))",
  "function paymentToken() external view returns (address)",
  "function treasury() external view returns (address)",
  "function PLATFORM_FEE_BPS() external view returns (uint256)",
  "function BPS() external view returns (uint256)",
  "function paused() external view returns (bool)",
  "event JobCreated(uint256 indexed jobId, address indexed client, address provider, address evaluator, uint256 expiredAt)",
  "event JobFunded(uint256 indexed jobId, address indexed client, uint256 budget)",
  "event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)",
  "event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason)",
  "event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason)",
  "event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount)",
  "event Refunded(uint256 indexed jobId, address indexed client, uint256 amount)",
  "event BudgetSet(uint256 indexed jobId, uint256 amount)",
  "event ProviderSet(uint256 indexed jobId, address provider)",
];

// ── Helpers ─────────────────────────────────────────────────────────────────

export function parseUSDCAmount(amount: string): bigint {
  const parts = amount.split(".");
  const intPart = parts[0] || "0";
  const decPart = (parts[1] || "").padEnd(6, "0").slice(0, 6);
  return BigInt(intPart) * 1_000_000n + BigInt(decPart);
}

export function formatUSDC(raw: bigint | number): string {
  return (Number(raw) / 1_000_000).toFixed(2);
}

export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function etherscanTx(hash: string): string {
  return `${ETHERSCAN_BASE}/tx/${hash}`;
}

export function etherscanAddr(addr: string): string {
  return `${ETHERSCAN_BASE}/address/${addr}`;
}

export const JOB_STATUS_LABELS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"] as const;
export const JOB_STATUS_COLORS = ["#4a90d9", "#f5a623", "#e67e22", "#27ae60", "#e74c3c", "#7f8c8d"] as const;

export const IDENTITY_ABI = [
  "function register(string calldata agentURI) external returns (uint256)",
  "function setAgentWallet(uint256 agentId, address wallet) external",
  "function updateURI(uint256 agentId, string calldata newURI) external",
  "function getAgent(uint256 agentId) external view returns (string memory uri, address owner, address wallet)",
  "function agentOf(address wallet) external view returns (uint256)",
  "function nextAgentId() external view returns (uint256)",
  "event AgentRegistered(uint256 indexed agentId, address indexed owner, string agentURI)",
  "event AgentWalletSet(uint256 indexed agentId, address indexed wallet)",
];

export const REPUTATION_ABI = [
  "function giveFeedback(uint256 agentId, uint8 score, bytes32[] calldata tags, bytes calldata proofOfPayment) external",
  "function getSummary(uint256 agentId) external view returns (uint256 totalFeedback, uint256 averageScore, uint256 lastUpdated)",
  "function getFeedback(uint256 agentId, uint256 index) external view returns (address reviewer, uint8 score, bytes32[] memory tags, uint256 timestamp)",
  "function feedbackCount(uint256 agentId) external view returns (uint256)",
  "event FeedbackGiven(uint256 indexed agentId, address indexed reviewer, uint8 score)",
];

export const ZERO_HANDLE = "0x" + "00".repeat(32);
export const ZERO_ADDRESS = "0x" + "00".repeat(20);
