import React, { useState, useRef } from "react";
import { BrowserProvider, JsonRpcSigner } from "ethers";
import { createInstance, SepoliaConfig, initSDK } from "@zama-fhe/relayer-sdk/web";
import WalletTab from "./WalletTab";
import JobsTab from "./JobsTab";
import PayTab from "./PayTab";
import DashboardTab from "./DashboardTab";
import AgentsTab from "./AgentsTab";
import { SEPOLIA_RPC, CHAIN_ID, shortAddr } from "./config";

// ── Types ───────────────────────────────────────────────────────────────────

interface FhevmInstance {
  createEncryptedInput: (contractAddress: string, userAddress: string) => {
    add64: (value: bigint | number) => void;
    addAddress: (value: string) => void;
    encrypt: () => Promise<{ handles: string[]; inputProof: string }>;
  };
}

interface TxRecord {
  action: string;
  txHash: string;
  amount?: string;
  timestamp: number;
}

type Tab = "wallet" | "pay" | "jobs" | "agents" | "dashboard";

const TABS: { key: Tab; label: string }[] = [
  { key: "wallet", label: "Wallet" },
  { key: "pay", label: "Pay API" },
  { key: "jobs", label: "Jobs" },
  { key: "agents", label: "Agents" },
  { key: "dashboard", label: "Dashboard" },
];

// ════════════════════════════════════════════════════════════════════════════

export default function App() {
  const [signer, setSigner] = useState<JsonRpcSigner | null>(null);
  const [address, setAddress] = useState("");
  const [tab, setTab] = useState<Tab>("wallet");
  const [status, setStatus] = useState("");
  const [statusType, setStatusType] = useState<"info" | "error" | "success">("info");
  const [txHistory, setTxHistory] = useState<TxRecord[]>([]);
  const [fhevmReady, setFhevmReady] = useState(false);
  const fhevmRef = useRef<FhevmInstance | null>(null);
  const fhevmInitPromise = useRef<Promise<FhevmInstance> | null>(null);

  const showStatus = (msg: string, type: "info" | "error" | "success" = "info") => {
    setStatus(msg);
    setStatusType(type);
  };

  const logTx = (action: string, txHash: string, amount?: string) => {
    setTxHistory((prev) => [{ action, txHash, amount, timestamp: Date.now() }, ...prev].slice(0, 50));
  };

  const getFhevmInstance = async (): Promise<FhevmInstance> => {
    if (fhevmRef.current) return fhevmRef.current;
    if (!fhevmInitPromise.current) {
      fhevmInitPromise.current = (async () => {
        const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
          Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms))]);

        console.log("[FHE] initSDK starting...");
        await withTimeout(initSDK({ tfheParams: "/tfhe_bg.wasm", kmsParams: "/kms_lib_bg.wasm", thread: 0 }), 30000, "initSDK");
        console.log("[FHE] initSDK done, creating instance...");

        // Always use RPC URL string — relayer-sdk expects string, not EIP-1193 provider
        const instance = await withTimeout(createInstance({ ...SepoliaConfig, network: SEPOLIA_RPC }), 30000, "createInstance");
        console.log("[FHE] instance created!");

        fhevmRef.current = instance as unknown as FhevmInstance;
        setFhevmReady(true);
        return fhevmRef.current;
      })();
    }
    return fhevmInitPromise.current;
  };

  const onConnect = async () => {
    const ethereum = (window as any).ethereum;
    if (!ethereum) {
      showStatus("MetaMask not found. Please install MetaMask.", "error");
      return;
    }
    try {
      const provider = new BrowserProvider(ethereum);
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== CHAIN_ID) {
        showStatus(`Switch to Sepolia (chainId ${CHAIN_ID})`, "error");
        try {
          await ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x" + CHAIN_ID.toString(16) }],
          });
        } catch {
          return;
        }
      }
      await provider.send("eth_requestAccounts", []);
      const s = await provider.getSigner();
      const addr = await s.getAddress();
      setSigner(s);
      setAddress(addr);
      showStatus(`Connected: ${shortAddr(addr)}. Initializing FHE engine...`, "info");

      getFhevmInstance()
        .then(() => showStatus(`Connected: ${shortAddr(addr)} | FHE ready`, "success"))
        .catch((e) => showStatus(`Connected: ${shortAddr(addr)} | FHE init failed: ${e.message}`, "error"));
    } catch (e: any) {
      showStatus(e.message || "Connection failed", "error");
    }
  };

  const statusBg =
    statusType === "error" ? "rgba(239,68,68,0.1)" : statusType === "success" ? "rgba(16,185,129,0.1)" : "rgba(45,212,191,0.08)";
  const statusColor = statusType === "error" ? "#EF4444" : statusType === "success" ? "#10B981" : "#2DD4BF";

  return (
    <div style={S.page}>
      {/* ── Hero ─────────────────────────────────────────────────── */}
      <header style={S.hero}>
        <div style={S.logoRow}>
          <span style={S.logo}>MARC Protocol</span>
          <span style={S.versionBadge}>V4.3</span>
        </div>
        <p style={S.tagline}>Confidential Payments for the AI Economy</p>
        <div style={S.badgeRow}>
          {["fhe-confidential-v1", "ERC-7984", "ERC-8183", "Zama fhEVM", "Sepolia"].map((b) => (
            <span key={b} style={S.badge}>{b}</span>
          ))}
        </div>
        <p style={S.desc}>
          AI agents pay for APIs with FHE-encrypted amounts. Balances stay private on-chain.
          Built on Zama fhEVM coprocessor + x402 HTTP payment standard.
        </p>

        {/* Infrastructure → Protocol Evolution Banner */}
        <div style={S.evolutionBanner}>
          <div style={S.evolutionHeader}>
            <span style={S.evolutionIcon}>&#9881;</span>
            <span style={S.evolutionTitle}>Infrastructure Today &rarr; Full Protocol Tomorrow</span>
          </div>
          <p style={S.evolutionText}>
            MARC is currently live as <strong style={{ color: "#2DD4BF" }}>privacy infrastructure</strong> for
            x402 payments on Ethereum Sepolia &mdash; handling encrypted transfers, nonce verification,
            and batch prepayments. With <strong style={{ color: "#2DD4BF" }}>ERC-8183</strong> (Agentic
            Commerce Protocol), we're evolving into a <strong style={{ color: "#2DD4BF" }}>complete protocol</strong> where
            AI agents autonomously create jobs, escrow funds, and settle payments &mdash; all with FHE privacy.
          </p>
          <div style={S.evolutionSteps}>
            <div style={S.evoStep}>
              <span style={S.evoStepDot}>&#9679;</span>
              <span><strong>Now:</strong> x402 payment infrastructure (wrap/pay/verify)</span>
            </div>
            <div style={S.evoStep}>
              <span style={S.evoStepDot}>&#9679;</span>
              <span><strong>Next:</strong> Ethereum Mainnet + ERC-8183 agentic commerce</span>
            </div>
            <div style={S.evoStep}>
              <span style={S.evoStepDot}>&#9679;</span>
              <span><strong>Future:</strong> Every chain Zama reaches (Base, Solana, Monad)</span>
            </div>
          </div>
        </div>
      </header>

      {/* ── Connect ──────────────────────────────────────────────── */}
      <div style={S.connectCard}>
        {signer ? (
          <div style={S.connectedRow}>
            <span style={S.dot} />
            <span style={{ color: "#fff", fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }}>
              {shortAddr(address)}
            </span>
            <span style={{ color: fhevmReady ? "#10B981" : "#F59E0B", fontSize: 11, marginLeft: "auto" }}>
              {fhevmReady ? "FHE Ready" : "FHE Loading..."}
            </span>
          </div>
        ) : (
          <button onClick={onConnect} style={S.connectBtn}>Connect Wallet</button>
        )}
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────── */}
      {signer && (
        <>
          <nav style={S.nav}>
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                style={tab === t.key ? S.tabActive : S.tabInactive}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <main className="fade-in" style={{ paddingBottom: status ? 56 : 16 }}>
            {tab === "wallet" && (
              <WalletTab signer={signer} address={address} onStatus={showStatus} onTx={logTx} fhevm={fhevmRef.current} txHistory={txHistory} />
            )}
            {tab === "pay" && (
              <PayTab signer={signer} address={address} onStatus={showStatus} onTx={logTx} fhevm={fhevmRef.current} />
            )}
            {tab === "jobs" && (
              <JobsTab signer={signer} address={address} onStatus={showStatus} onTx={logTx} />
            )}
            {tab === "agents" && (
              <AgentsTab signer={signer} address={address} onStatus={showStatus} onTx={logTx} />
            )}
            {tab === "dashboard" && (
              <DashboardTab signer={signer} address={address} txHistory={txHistory} />
            )}
          </main>
        </>
      )}

      {/* ── Status ───────────────────────────────────────────────── */}
      {status && (
        <div style={{ ...S.statusBar, background: statusBg, color: statusColor, borderTop: `1px solid ${statusColor}22` }}>
          {status}
        </div>
      )}

      {/* ── Footer ───────────────────────────────────────────────── */}
      <footer style={S.footer}>
        <span>MARC Protocol</span>
        <span style={{ color: "#2a2a2a" }}>|</span>
        <span>Powered by Zama fhEVM</span>
        <span style={{ color: "#2a2a2a" }}>|</span>
        <a href="https://github.com/Himess/marc-protocol" target="_blank" rel="noopener noreferrer" style={{ color: "#2DD4BF", textDecoration: "none" }}>
          GitHub
        </a>
      </footer>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Styles — Pendex-inspired theme
// ════════════════════════════════════════════════════════════════════════════

const GOLD = "#2DD4BF";
const BG = "#0A0A0B";
const CARD = "#141414";
const BORDER = "#2a2a2a";

const S: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: 720,
    margin: "0 auto",
    padding: "0 20px",
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
  },
  hero: { textAlign: "center", padding: "48px 0 28px" },
  logoRow: { display: "flex", alignItems: "center", justifyContent: "center", gap: 10 },
  logo: {
    fontSize: 36,
    fontWeight: 800,
    background: `linear-gradient(135deg, ${GOLD}, #14B8A6)`,
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    letterSpacing: -1,
  },
  versionBadge: {
    background: `${GOLD}18`,
    color: GOLD,
    padding: "3px 10px",
    borderRadius: 6,
    fontSize: 11,
    fontWeight: 600,
    border: `1px solid ${GOLD}30`,
  },
  tagline: { fontSize: 15, color: "#A0A0A0", marginTop: 8, fontWeight: 500 },
  badgeRow: { display: "flex", justifyContent: "center", gap: 6, marginTop: 16, flexWrap: "wrap" as const },
  badge: {
    background: CARD,
    color: "#A0A0A0",
    padding: "4px 12px",
    borderRadius: 20,
    fontSize: 10,
    border: `1px solid ${BORDER}`,
    fontWeight: 500,
    letterSpacing: 0.3,
  },
  desc: { color: "#6B7280", fontSize: 12, maxWidth: 500, margin: "14px auto 0", lineHeight: 1.6 },
  evolutionBanner: {
    background: `linear-gradient(135deg, ${CARD}, #1a1a2e)`,
    border: `1px solid ${GOLD}30`,
    borderRadius: 12,
    padding: "18px 22px",
    marginTop: 20,
    textAlign: "left" as const,
    maxWidth: 560,
    marginLeft: "auto",
    marginRight: "auto",
  },
  evolutionHeader: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10 },
  evolutionIcon: { fontSize: 16, color: GOLD },
  evolutionTitle: { fontSize: 13, fontWeight: 700, color: "#E5E7EB" },
  evolutionText: { fontSize: 11, color: "#9CA3AF", lineHeight: 1.7, margin: "0 0 12px 0" },
  evolutionSteps: { display: "flex", flexDirection: "column" as const, gap: 6 },
  evoStep: { display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "#D1D5DB" },
  evoStepDot: { color: GOLD, fontSize: 8 },

  // Connect
  connectCard: {
    background: CARD,
    borderRadius: 12,
    padding: "14px 20px",
    border: `1px solid ${BORDER}`,
    marginBottom: 12,
  },
  connectBtn: {
    background: `linear-gradient(135deg, ${GOLD}, #14B8A6)`,
    color: BG,
    border: "none",
    borderRadius: 10,
    padding: "13px 32px",
    fontWeight: 700,
    cursor: "pointer",
    fontSize: 14,
    width: "100%",
    boxShadow: `0 0 20px rgba(45,212,191,0.25)`,
  },
  connectedRow: { display: "flex", alignItems: "center", gap: 10 },
  dot: { width: 8, height: 8, borderRadius: "50%", background: "#10B981", display: "inline-block", boxShadow: "0 0 6px rgba(16,185,129,0.5)" },

  // Nav
  nav: {
    display: "flex",
    gap: 2,
    background: BG,
    borderRadius: 10,
    padding: 3,
    marginBottom: 16,
    border: `1px solid ${BORDER}`,
  },
  tabActive: {
    flex: 1,
    background: GOLD,
    color: BG,
    border: "none",
    borderRadius: 8,
    padding: "10px 0",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 700,
  },
  tabInactive: {
    flex: 1,
    background: "transparent",
    color: "#6B7280",
    border: "none",
    borderRadius: 8,
    padding: "10px 0",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 500,
  },

  // Status
  statusBar: {
    position: "fixed" as const,
    bottom: 0,
    left: 0,
    right: 0,
    padding: "12px 20px",
    fontSize: 12,
    textAlign: "center" as const,
    wordBreak: "break-all" as const,
    zIndex: 100,
    fontFamily: "'JetBrains Mono', monospace",
    backdropFilter: "blur(12px)",
  },

  // Footer
  footer: {
    textAlign: "center" as const,
    padding: "28px 0",
    fontSize: 11,
    color: "#3a3a3a",
    display: "flex",
    justifyContent: "center",
    gap: 8,
    marginTop: "auto",
  },
};
