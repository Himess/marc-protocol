import React, { useState, useRef } from "react";
import ConnectWallet from "./components/ConnectWallet";
import BalanceDisplay from "./components/BalanceDisplay";
import DepositForm from "./components/DepositForm";
import PayForm from "./components/PayForm";
import WithdrawForm from "./components/WithdrawForm";
import { BrowserProvider, JsonRpcSigner, Contract, ethers } from "ethers";
import { initFhevm, createInstance } from "fhevmjs/web";

const POOL_ADDRESS = "0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73";
const USDC_ADDRESS = "0x229146B746cf3A314dee33f08b84f8EFd5F314F4";
const CHAIN_ID = 11155111;
const GATEWAY_URL = "https://gateway.sepolia.zama.ai";

const POOL_ABI = [
  "function deposit(uint64 amount) external",
  "function pay(address to, externalEuint64 encryptedAmount, bytes calldata inputProof, uint64 minPrice, bytes32 nonce) external",
  "function requestWithdraw(externalEuint64 encryptedAmount, bytes calldata inputProof) external",
  "function isInitialized(address account) external view returns (bool)",
];

const USDC_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
];

interface FhevmInstance {
  createEncryptedInput: (contractAddress: string, userAddress: string) => {
    add64: (value: bigint | number) => void;
    encrypt: () => Promise<{ handles: string[]; inputProof: string }>;
  };
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 600,
    margin: "0 auto",
    padding: "40px 20px",
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
  const fhevmRef = useRef<FhevmInstance | null>(null);
  const fhevmInitPromise = useRef<Promise<FhevmInstance> | null>(null);

  const showStatus = (msg: string, type: "info" | "error" | "success" = "info") => {
    setStatus(msg);
    setStatusType(type);
  };

  const getFhevmInstance = async (): Promise<FhevmInstance> => {
    if (fhevmRef.current) return fhevmRef.current;
    if (!fhevmInitPromise.current) {
      fhevmInitPromise.current = (async () => {
        await initFhevm();
        const provider = new BrowserProvider((window as any).ethereum);
        const network = await provider.getNetwork();
        const instance = await createInstance({
          chainId: Number(network.chainId),
          networkUrl: provider._getConnection().url,
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
    const pool = new Contract(POOL_ADDRESS, POOL_ABI, signer);
    const usdc = new Contract(USDC_ADDRESS, USDC_ABI, signer);
    return { pool, usdc };
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

  const onDeposit = async (amount: string) => {
    try {
      showStatus("Approving USDC...", "info");
      const { pool, usdc } = getContracts();
      const raw = BigInt(Math.round(parseFloat(amount) * 1_000_000));
      const approveTx = await usdc.approve(POOL_ADDRESS, raw);
      await approveTx.wait();

      showStatus("Depositing...", "info");
      const tx = await pool.deposit(raw);
      const receipt = await tx.wait();
      showStatus(`Deposited ${amount} USDC | TX: ${receipt.hash}`, "success");
    } catch (e: any) {
      showStatus(e.message || "Deposit failed", "error");
    }
  };

  const onPay = async (to: string, amount: string) => {
    try {
      showStatus("Initializing FHE encryption...", "info");
      const fhevm = await getFhevmInstance();
      const { pool } = getContracts();
      const raw = BigInt(Math.round(parseFloat(amount) * 1_000_000));

      showStatus("Encrypting payment amount...", "info");
      const input = fhevm.createEncryptedInput(POOL_ADDRESS, address);
      input.add64(raw);
      const encrypted = await input.encrypt();

      const nonce = ethers.hexlify(ethers.randomBytes(32));

      showStatus("Submitting encrypted payment...", "info");
      const tx = await pool.pay(
        to,
        encrypted.handles[0],
        encrypted.inputProof,
        raw,
        nonce
      );
      const receipt = await tx.wait();
      showStatus(`Paid ${amount} USDC to ${to.slice(0, 8)}... | TX: ${receipt.hash}`, "success");
    } catch (e: any) {
      showStatus(e.message || "Payment failed", "error");
    }
  };

  const onWithdraw = async (amount: string) => {
    try {
      showStatus("Initializing FHE encryption...", "info");
      const fhevm = await getFhevmInstance();
      const { pool } = getContracts();
      const raw = BigInt(Math.round(parseFloat(amount) * 1_000_000));

      showStatus("Encrypting withdrawal amount...", "info");
      const input = fhevm.createEncryptedInput(POOL_ADDRESS, address);
      input.add64(raw);
      const encrypted = await input.encrypt();

      showStatus("Requesting withdrawal...", "info");
      const tx = await pool.requestWithdraw(encrypted.handles[0], encrypted.inputProof);
      const receipt = await tx.wait();
      showStatus(`Withdrawal requested for ${amount} USDC | TX: ${receipt.hash}. Awaiting KMS finalization.`, "success");
    } catch (e: any) {
      showStatus(e.message || "Withdrawal failed", "error");
    }
  };

  const statusBg = statusType === "error" ? "#2a1515" : statusType === "success" ? "#152a15" : "#1a1a2e";
  const statusColor = statusType === "error" ? "#ff6b6b" : statusType === "success" ? "#6bff6b" : "#7b68ee";

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.title}>FHE x402 Demo</div>
        <div style={styles.subtitle}>Encrypted USDC payments on Ethereum Sepolia</div>
        <div style={styles.badge}>fhe-confidential-v1</div>
      </div>

      <div style={styles.section}>
        <ConnectWallet address={address} onConnect={onConnect} />
      </div>

      {signer && (
        <>
          <div style={styles.section}>
            <BalanceDisplay address={address} signer={signer} usdcAddress={USDC_ADDRESS} poolAddress={POOL_ADDRESS} />
          </div>

          <div style={styles.section}>
            <DepositForm onDeposit={onDeposit} />
          </div>

          <div style={styles.section}>
            <PayForm onPay={onPay} />
          </div>

          <div style={styles.section}>
            <WithdrawForm onWithdraw={onWithdraw} />
          </div>
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
