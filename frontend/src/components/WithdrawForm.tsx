import React, { useState } from "react";

interface Props {
  onWithdraw: (amount: string) => void;
}

const styles: Record<string, React.CSSProperties> = {
  label: { fontSize: 16, fontWeight: 600, marginBottom: 12 },
  row: { display: "flex", gap: 8 },
  input: {
    flex: 1,
    background: "#1a1a1a",
    border: "1px solid #333",
    borderRadius: 8,
    padding: "10px 14px",
    color: "#e0e0e0",
    fontSize: 14,
  },
  btn: {
    background: "#c62828",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "10px 20px",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 600,
  },
  note: { fontSize: 12, color: "#666", marginTop: 8 },
};

export default function WithdrawForm({ onWithdraw }: Props) {
  const [amount, setAmount] = useState("");

  return (
    <div>
      <div style={styles.label}>Request Withdraw</div>
      <div style={styles.row}>
        <input
          style={styles.input}
          placeholder="Amount USDC"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <button style={styles.btn} onClick={() => { onWithdraw(amount); setAmount(""); }}>
          Request
        </button>
      </div>
      <div style={styles.note}>Step 1 only. Step 2 (finalize) requires async KMS decryption callback.</div>
    </div>
  );
}
