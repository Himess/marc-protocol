import React, { useState } from "react";
import { ethers } from "ethers";

interface Props {
  onPay: (to: string, amount: string) => Promise<void>;
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
  btnDisabled: {
    background: "#444",
    color: "#888",
    border: "none",
    borderRadius: 8,
    padding: "10px 20px",
    cursor: "not-allowed",
    fontSize: 14,
    fontWeight: 600,
  },
  error: { color: "#ff6b6b", fontSize: 12, marginTop: 4 },
};

export default function PayForm({ onPay }: Props) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const validate = (): string | null => {
    if (!to || !ethers.isAddress(to)) return "Invalid recipient address";
    const num = parseFloat(amount);
    if (isNaN(num) || num <= 0) return "Amount must be a positive number";
    if (num < 0.01) return "Minimum payment is 0.01 USDC";
    return null;
  };

  const handlePay = async () => {
    const err = validate();
    if (err) { setError(err); return; }
    setError("");
    setLoading(true);
    try {
      await onPay(to, amount);
      setTo("");
      setAmount("");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div style={styles.label}>Pay (Encrypted)</div>
      <input
        style={styles.input}
        placeholder="Recipient address (0x...)"
        value={to}
        onChange={(e) => { setTo(e.target.value); setError(""); }}
        disabled={loading}
      />
      <div style={styles.row}>
        <input
          style={{ ...styles.input, flex: 1, marginBottom: 0 }}
          placeholder="Amount USDC"
          type="number"
          step="0.01"
          min="0.01"
          value={amount}
          onChange={(e) => { setAmount(e.target.value); setError(""); }}
          disabled={loading}
        />
        <button
          style={loading ? styles.btnDisabled : styles.btn}
          onClick={handlePay}
          disabled={loading}
        >
          {loading ? "Paying..." : "Pay"}
        </button>
      </div>
      {error && <div style={styles.error}>{error}</div>}
    </div>
  );
}
