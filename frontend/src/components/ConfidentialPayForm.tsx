import React, { useState } from "react";

interface Props {
  onPayConfidential: (recipient: string, amount: string) => Promise<void>;
}

const styles: Record<string, React.CSSProperties> = {
  label: { fontSize: 16, fontWeight: 600, marginBottom: 12 },
  input: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid #333",
    background: "#1a1a1a",
    color: "#fff",
    fontSize: 14,
    marginBottom: 8,
    boxSizing: "border-box",
  },
  button: {
    width: "100%",
    padding: "10px 16px",
    borderRadius: 8,
    border: "none",
    background: "#7b68ee",
    color: "#fff",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    marginTop: 4,
  },
  hint: { fontSize: 11, color: "#666", marginBottom: 8 },
};

export default function ConfidentialPayForm({ onPayConfidential }: Props) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!recipient || !amount) return;
    setLoading(true);
    try {
      await onPayConfidential(recipient, amount);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div style={styles.label}>Confidential Pay (V2.0)</div>
      <div style={styles.hint}>Recipient address is encrypted on-chain. Claim required.</div>
      <input
        style={styles.input}
        placeholder="Recipient address (0x...)"
        value={recipient}
        onChange={(e) => setRecipient(e.target.value)}
      />
      <input
        style={styles.input}
        placeholder="Amount (USDC)"
        type="number"
        step="0.01"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <button style={styles.button} onClick={handleSubmit} disabled={loading}>
        {loading ? "Encrypting & Sending..." : "Pay Confidentially"}
      </button>
    </div>
  );
}
