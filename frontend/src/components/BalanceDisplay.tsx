import React, { useEffect, useState } from "react";
import { Contract, JsonRpcSigner } from "ethers";

interface Props {
  address: string;
  signer: JsonRpcSigner;
  usdcAddress: string;
  poolAddress: string;
}

const USDC_ABI = ["function balanceOf(address) view returns (uint256)"];
const POOL_ABI = [
  "function isInitialized(address) view returns (bool)",
  "function paused() view returns (bool)",
  "function withdrawRequestedAt(address) view returns (uint256)",
];

const styles: Record<string, React.CSSProperties> = {
  label: { fontSize: 16, fontWeight: 600, marginBottom: 12 },
  row: { display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 14 },
  value: { color: "#7b68ee", fontFamily: "monospace" },
  refresh: {
    background: "transparent",
    border: "1px solid #333",
    color: "#888",
    borderRadius: 6,
    padding: "6px 16px",
    cursor: "pointer",
    fontSize: 12,
    marginTop: 8,
  },
};

export default function BalanceDisplay({ address, signer, usdcAddress, poolAddress }: Props) {
  const [usdcBalance, setUsdcBalance] = useState<string>("...");
  const [isInit, setIsInit] = useState<boolean | null>(null);
  const [isPaused, setIsPaused] = useState<boolean | null>(null);
  const [withdrawPending, setWithdrawPending] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const usdc = new Contract(usdcAddress, USDC_ABI, signer);
      const pool = new Contract(poolAddress, POOL_ABI, signer);
      const bal: bigint = await usdc.balanceOf(address);
      setUsdcBalance((Number(bal) / 1_000_000).toFixed(2));
      const init = await pool.isInitialized(address);
      setIsInit(init);
      const paused = await pool.paused();
      setIsPaused(paused);
      const withdrawTs: bigint = await pool.withdrawRequestedAt(address);
      if (withdrawTs > 0n) {
        const date = new Date(Number(withdrawTs) * 1000);
        setWithdrawPending(date.toLocaleString());
      } else {
        setWithdrawPending(null);
      }
    } catch {
      setUsdcBalance("Error");
    }
  };

  useEffect(() => { refresh(); }, [address]);

  return (
    <div>
      <div style={styles.label}>Balance</div>
      <div style={styles.row}>
        <span>Public USDC</span>
        <span style={styles.value}>{usdcBalance} USDC</span>
      </div>
      <div style={styles.row}>
        <span>Pool Initialized</span>
        <span style={styles.value}>{isInit === null ? "..." : isInit ? "Yes" : "No"}</span>
      </div>
      <div style={styles.row}>
        <span>Encrypted Balance</span>
        <span style={{ color: "#666", fontSize: 12 }}>Requires KMS decryption</span>
      </div>
      <div style={styles.row}>
        <span>Contract Paused</span>
        <span style={{
          ...styles.value,
          color: isPaused === null ? "#7b68ee" : isPaused ? "#ff6b6b" : "#6bff6b",
        }}>
          {isPaused === null ? "..." : isPaused ? "Yes" : "No"}
        </span>
      </div>
      <div style={styles.row}>
        <span>Pending Withdrawal</span>
        <span style={{
          ...styles.value,
          color: withdrawPending ? "#ffb347" : "#7b68ee",
          fontSize: withdrawPending ? 11 : 14,
        }}>
          {withdrawPending ?? "None"}
        </span>
      </div>
      <button style={styles.refresh} onClick={refresh}>Refresh</button>
    </div>
  );
}
