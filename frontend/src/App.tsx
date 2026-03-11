import React, { useState, useRef } from "react";
import ConnectWallet from "./components/ConnectWallet";
import BalanceDisplay from "./components/BalanceDisplay";
import WrapForm from "./components/DepositForm";
import PayForm from "./components/PayForm";
import UnwrapForm from "./components/WithdrawForm";
import { BrowserProvider, JsonRpcSigner, Contract, ethers } from "ethers";
import { initFhevm, createInstance } from "fhevmjs/web";

// Sepolia RPC URL used for fhevmjs initialization
const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

const TOKEN_ADDRESS = "0x3864B98D1B1EC2109C679679052e2844b4153889"; // ConfidentialUSDC
const VERIFIER_ADDRESS = "0xCc60280A10FEB7fBdf20fBefc2abe6E0e99A5A83"; // X402PaymentVerifier
const USDC_ADDRESS = "0xc89e913676B034f8b38E49f7508803d1cDEC9F4f"; // MockUSDC (V4.0 deploy)
const CHAIN_ID = 11155111;
const GATEWAY_URL = "https://gateway.sepolia.zama.ai";

const TOKEN_ABI = [
  "function wrap(address to, uint256 amount) external",
  "function unwrap(address from, address to, bytes32 encryptedAmount, bytes calldata inputProof) external",
  "function confidentialTransfer(address to, bytes32 encryptedAmount, bytes calldata inputProof) external returns (bytes32)",
  "function confidentialBalanceOf(address account) external view returns (bytes32)",
  "function paused() external view returns (bool)",
  "function accumulatedFees() external view returns (uint256)",
];

const VERIFIER_ABI = [
  "function recordPayment(address payer, address server, bytes32 nonce, uint64 minPrice) external",
];

const USDC_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
];

interface FhevmInstance {
  createEncryptedInput: (contractAddress: string, userAddress: string) => {
    add64: (value: bigint | number) => void;
    addAddress: (value: string) => void;
    encrypt: () => Promise<{ handles: string[]; inputProof: string }>;
  };
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 600,
    margin: "0 auto",
    padding: "40px 20px",
    minHeight: "100vh",
  },
  header: {
    textAlign: "center",
    marginBottom: 40,
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
    color: "#fff",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: "#888",
  },
  badge: {
    display: "inline-block",
    background: "#1a1a2e",
    color: "#7b68ee",
    padding: "4px 12px",
    borderRadius: 12,
    fontSize: 12,
    marginTop: 8,
  },
  section: {
    background: "#111",
    borderRadius: 12,
    padding: 24,
    marginBottom: 16,
    border: "1px solid #222",
  },
  status: {
    padding: "12px 16px",
    borderRadius: 8,
    marginTop: 16,
    fontSize: 13,
    wordBreak: "break-all" as const,
  },
};

export default function App() {
  const [signer, setSigner] = useState<JsonRpcSigner | null>(null);
  const [address, setAddress] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [statusType, setStatusType] = useState<"info" | "error" | "success">("info");
  const [txHistory, setTxHistory] = useState<Array<{action: string; txHash: string; amount?: string; timestamp: number}>>([]);
  const fhevmRef = useRef<FhevmInstance | null>(null);
  const fhevmInitPromise = useRef<Promise<FhevmInstance> | null>(null);

  const showStatus = (msg: string, type: "info" | "error" | "success" = "info") => {
    setStatus(msg);
    setStatusType(type);
  };

  const logTx = (action: string, txHash: string, amount?: string) => {
    setTxHistory(prev => [{action, txHash, amount, timestamp: Date.now()}, ...prev].slice(0, 20));
  };

  const getFhevmInstance = async (): Promise<FhevmInstance> => {
    if (fhevmRef.current) return fhevmRef.current;
    if (!fhevmInitPromise.current) {
      fhevmInitPromise.current = (async () => {
        await initFhevm();
        const instance = await createInstance({
          chainId: CHAIN_ID,
          networkUrl: SEPOLIA_RPC,
          gatewayUrl: GATEWAY_URL,
        });
        fhevmRef.current = instance as unknown as FhevmInstance;
        return fhevmRef.current;
      })();
    }
    return fhevmInitPromise.current;
  };

  const getContracts = () => {
    if (!signer) throw new Error("Wallet not connected");
    const token = new Contract(TOKEN_ADDRESS, TOKEN_ABI, signer);
    const verifier = new Contract(VERIFIER_ADDRESS, VERIFIER_ABI, signer);
    const usdc = new Contract(USDC_ADDRESS, USDC_ABI, signer);
    return { token, verifier, usdc };
  };

  const onConnect = async () => {
    if (!(window as any).ethereum) {
      showStatus("MetaMask not found", "error");
      return;
    }
    try {
      const provider = new BrowserProvider((window as any).ethereum);
      await provider.send("eth_requestAccounts", []);
      const s = await provider.getSigner();
      const addr = await s.getAddress();
      setSigner(s);
      setAddress(addr);
      showStatus(`Connected: ${addr.slice(0, 6)}...${addr.slice(-4)}. Initializing FHE...`, "info");

      // Pre-initialize fhevmjs in the background
      getFhevmInstance()
        .then(() => showStatus(`Connected: ${addr.slice(0, 6)}...${addr.slice(-4)} | FHE ready`, "success"))
        .catch((e) => showStatus(`Connected but FHE init failed: ${e.message}`, "error"));
    } catch (e: any) {
      showStatus(e.message || "Connection failed", "error");
    }
  };

  const onWrap = async (amount: string) => {
    try {
      showStatus("Approving USDC...", "info");
      const { token, usdc } = getContracts();
      const raw = BigInt(Math.round(parseFloat(amount) * 1_000_000));
      const approveTx = await usdc.approve(TOKEN_ADDRESS, raw);
      await approveTx.wait();

      showStatus("Wrapping USDC to cUSDC...", "info");
      const tx = await token.wrap(address, raw);
      const receipt = await tx.wait();
      showStatus(`Wrapped ${amount} USDC to cUSDC | TX: ${receipt.hash}`, "success");
      logTx("Wrap", receipt.hash, amount);
    } catch (e: any) {
      showStatus(e.message || "Wrap failed", "error");
    }
  };

  const onPay = async (to: string, amount: string) => {
    try {
      showStatus("Initializing FHE encryption...", "info");
      const fhevm = await getFhevmInstance();
      const { token, verifier } = getContracts();
      const raw = BigInt(Math.round(parseFloat(amount) * 1_000_000));

      showStatus("Encrypting payment amount...", "info");
      const input = fhevm.createEncryptedInput(TOKEN_ADDRESS, address);
      input.add64(raw);
      const encrypted = await input.encrypt();

      showStatus("Submitting encrypted transfer...", "info");
      const tx = await token.confidentialTransfer(to, encrypted.handles[0], encrypted.inputProof);
      const receipt = await tx.wait();

      // Record payment nonce on verifier
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      showStatus("Recording payment nonce...", "info");
      const vTx = await verifier.recordPayment(address, to, nonce, raw);
      await vTx.wait();

      showStatus(`Paid ${amount} cUSDC to ${to.slice(0, 8)}... | TX: ${receipt.hash}`, "success");
      logTx("Pay", receipt.hash, amount);
    } catch (e: any) {
      showStatus(e.message || "Payment failed", "error");
    }
  };

  const onUnwrap = async (amount: string) => {
    try {
      showStatus("Initializing FHE encryption...", "info");
      const fhevm = await getFhevmInstance();
      const { token } = getContracts();
      const raw = BigInt(Math.round(parseFloat(amount) * 1_000_000));

      showStatus("Encrypting unwrap amount...", "info");
      const input = fhevm.createEncryptedInput(TOKEN_ADDRESS, address);
      input.add64(raw);
      const encrypted = await input.encrypt();

      showStatus("Requesting unwrap...", "info");
      const tx = await token.unwrap(address, address, encrypted.handles[0], encrypted.inputProof);
      const receipt = await tx.wait();
      showStatus(`Unwrap requested for ${amount} cUSDC | TX: ${receipt.hash}. Awaiting KMS finalization.`, "success");
      logTx("Unwrap Request", receipt.hash, amount);
    } catch (e: any) {
      showStatus(e.message || "Unwrap failed", "error");
    }
  };

  const statusBg = statusType === "error" ? "#2a1515" : statusType === "success" ? "#152a15" : "#1a1a2e";
  const statusColor = statusType === "error" ? "#ff6b6b" : statusType === "success" ? "#6bff6b" : "#7b68ee";

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.title}>FHE x402 Demo</div>
        <div style={styles.subtitle}>Encrypted USDC payments on Ethereum Sepolia (V4.0 Token-Centric)</div>
        <div style={styles.badge}>fhe-confidential-v1</div>
      </div>

      <div style={styles.section}>
        <ConnectWallet address={address} onConnect={onConnect} />
      </div>

      {signer && (
        <>
          <div style={styles.section}>
            <BalanceDisplay address={address} signer={signer} usdcAddress={USDC_ADDRESS} tokenAddress={TOKEN_ADDRESS} />
          </div>

          <div style={styles.section}>
            <WrapForm onWrap={onWrap} />
          </div>

          <div style={styles.section}>
            <PayForm onPay={onPay} />
          </div>

          <div style={styles.section}>
            <UnwrapForm onUnwrap={onUnwrap} />
          </div>

          {txHistory.length > 0 && (
            <div style={styles.section}>
              <h3 style={{color: '#fff', margin: '0 0 12px 0', fontSize: 16}}>Transaction History</h3>
              {txHistory.map((tx, i) => (
                <div key={i} style={{
                  padding: '8px 0',
                  borderBottom: i < txHistory.length - 1 ? '1px solid #222' : 'none',
                  fontSize: 12,
                  color: '#aaa',
                }}>
                  <span style={{color: '#7b68ee', fontWeight: 600}}>{tx.action}</span>
                  {tx.amount && <span> — {tx.amount} USDC</span>}
                  <br />
                  <a
                    href={`https://sepolia.etherscan.io/tx/${tx.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{color: '#4a90d9', textDecoration: 'none', fontSize: 11}}
                  >
                    {tx.txHash.slice(0, 10)}...{tx.txHash.slice(-8)}
                  </a>
                  <span style={{float: 'right', fontSize: 11}}>
                    {new Date(tx.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {status && (
        <div style={{ ...styles.status, background: statusBg, color: statusColor }}>
          {status}
        </div>
      )}
    </div>
  );
}
