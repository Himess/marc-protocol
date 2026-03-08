import React from "react";

interface Props {
  address: string;
  onConnect: () => void;
}

const styles: Record<string, React.CSSProperties> = {
  row: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  label: { fontSize: 16, fontWeight: 600 },
  addr: { fontSize: 13, color: "#7b68ee", fontFamily: "monospace" },
  btn: {
    background: "#7b68ee",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "10px 24px",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 600,
  },
};

export default function ConnectWallet({ address, onConnect }: Props) {
  return (
    <div style={styles.row}>
      <div>
        <div style={styles.label}>Wallet</div>
        {address ? (
          <div style={styles.addr}>{address.slice(0, 6)}...{address.slice(-4)}</div>
        ) : (
          <div style={{ color: "#666", fontSize: 13 }}>Not connected</div>
        )}
      </div>
      {!address && (
        <button style={styles.btn} onClick={onConnect}>Connect MetaMask</button>
      )}
    </div>
  );
}
