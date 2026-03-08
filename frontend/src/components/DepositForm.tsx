import React, { useState } from "react";

interface Props {
  onDeposit: (amount: string) => void;
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
    background: "#2e7d32",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "10px 20px",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 600,
  },
};

export default function DepositForm({ onDeposit }: Props) {
  const [amount, setAmount] = useState("");

  return (
    <div>
      <div style={styles.label}>Deposit USDC</div>
      <div style={styles.row}>
        <input
          style={styles.input}
          placeholder="Amount (e.g. 10)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <button style={styles.btn} onClick={() => { onDeposit(amount); setAmount(""); }}>
          Deposit
        </button>
      </div>
    </div>
  );
}
