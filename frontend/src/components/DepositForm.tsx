import React, { useState } from "react";

interface Props {
  onDeposit: (amount: string) => Promise<void>;
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

export default function DepositForm({ onDeposit }: Props) {
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleDeposit = async () => {
    const num = parseFloat(amount);
    if (isNaN(num) || num <= 0) {
      setError("Amount must be a positive number");
      return;
    }
    if (num < 0.01) {
      setError("Minimum deposit is 0.01 USDC");
      return;
    }
    setError("");
    setLoading(true);
    try {
      await onDeposit(amount);
      setAmount("");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div style={styles.label}>Deposit USDC</div>
      <div style={styles.row}>
        <input
          style={styles.input}
          placeholder="Amount (e.g. 10)"
          type="number"
          step="0.01"
          min="0.01"
          value={amount}
          onChange={(e) => { setAmount(e.target.value); setError(""); }}
          disabled={loading}
        />
        <button
          style={loading ? styles.btnDisabled : styles.btn}
          onClick={handleDeposit}
          disabled={loading}
        >
          {loading ? "Depositing..." : "Deposit"}
        </button>
      </div>
      {error && <div style={styles.error}>{error}</div>}
    </div>
  );
}
