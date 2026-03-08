import React, { useState } from "react";

interface Props {
  onPay: (to: string, amount: string) => void;
}

const styles: Record<string, React.CSSProperties> = {
  label: { fontSize: 16, fontWeight: 600, marginBottom: 12 },
  input: {
    width: "100%",
    background: "#1a1a1a",
    border: "1px solid #333",
    borderRadius: 8,
    padding: "10px 14px",
    color: "#e0e0e0",
    fontSize: 14,
    marginBottom: 8,
  },
  row: { display: "flex", gap: 8 },
  btn: {
    background: "#7b68ee",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "10px 20px",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 600,
  },
};

export default function PayForm({ onPay }: Props) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");

  return (
    <div>
      <div style={styles.label}>Pay (Encrypted)</div>
      <input
        style={styles.input}
        placeholder="Recipient address (0x...)"
        value={to}
        onChange={(e) => setTo(e.target.value)}
      />
      <div style={styles.row}>
        <input
          style={{ ...styles.input, flex: 1, marginBottom: 0 }}
          placeholder="Amount USDC"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <button style={styles.btn} onClick={() => { onPay(to, amount); setTo(""); setAmount(""); }}>
          Pay
        </button>
      </div>
    </div>
  );
}
