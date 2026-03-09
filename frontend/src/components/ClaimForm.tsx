import React, { useState } from "react";

interface Props {
  onClaimPayment: (paymentId: string) => Promise<void>;
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
    background: "#4a90d9",
    color: "#fff",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    marginTop: 4,
  },
  hint: { fontSize: 11, color: "#666", marginBottom: 8 },
};

export default function ClaimForm({ onClaimPayment }: Props) {
  const [paymentId, setPaymentId] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!paymentId) return;
    setLoading(true);
    try {
      await onClaimPayment(paymentId);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div style={styles.label}>Claim Payment (V2.0)</div>
      <div style={styles.hint}>Enter payment ID to claim a confidential payment sent to you.</div>
      <input
        style={styles.input}
        placeholder="Payment ID (0, 1, 2...)"
        type="number"
        value={paymentId}
        onChange={(e) => setPaymentId(e.target.value)}
      />
      <button style={styles.button} onClick={handleSubmit} disabled={loading}>
        {loading ? "Encrypting & Claiming..." : "Claim Payment"}
      </button>
    </div>
  );
}
