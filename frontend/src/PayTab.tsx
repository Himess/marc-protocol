import React, { useState } from "react";
import { Contract, JsonRpcSigner, ethers } from "ethers";
import { ADDRESSES, TOKEN_ABI, VERIFIER_ABI, parseUSDCAmount, etherscanTx, shortAddr } from "./config";
import { C, card, cardTitle, hint, inputStyle, inputLabel, btnPrimary, link, FONT_MONO } from "./theme";

interface Props {
  signer: JsonRpcSigner;
  address: string;
  onStatus: (msg: string, type: "info" | "error" | "success") => void;
  onTx: (action: string, txHash: string, amount?: string) => void;
  fhevm: any;
}

type Step = { label: string; status: "pending" | "active" | "done" | "error"; txHash?: string; detail?: string };

export default function PayTab({ signer, address, onStatus, onTx, fhevm }: Props) {
  const [recipient, setRecipient] = useState<string>(ADDRESSES.TREASURY);
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<"single" | "batch">("single");
  const [batchCount, setBatchCount] = useState("10");
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);

  const updateStep = (i: number, u: Partial<Step>) => setSteps((p) => p.map((s, j) => (j === i ? { ...s, ...u } : s)));

  const runPayment = async () => {
    if (!recipient || !amount || !fhevm || running) return;
    setRunning(true);
    const isBatch = mode === "batch";
    const count = parseInt(batchCount) || 10;
    const pricePerReq = parseUSDCAmount(amount);
    const total = isBatch ? pricePerReq * BigInt(count) : pricePerReq;

    const initialSteps: Step[] = [
      { label: isBatch ? `Encrypt total (${count} x ${amount} USDC)` : "Encrypt amount with FHE", status: "pending" },
      { label: "Send confidentialTransfer", status: "pending" },
      { label: isBatch ? `Record batch nonce (${count} reqs)` : "Record payment nonce", status: "pending" },
    ];
    setSteps(initialSteps);

    const token = new Contract(ADDRESSES.TOKEN, TOKEN_ABI, signer);
    const verifier = new Contract(ADDRESSES.VERIFIER, VERIFIER_ABI, signer);

    try {
      // Step 1
      updateStep(0, { status: "active" });
      onStatus("Encrypting with FHE...", "info");
      const t0 = Date.now();
      const input = fhevm.createEncryptedInput(ADDRESSES.TOKEN, address);
      input.add64(total);
      const encrypted = await input.encrypt();
      updateStep(0, { status: "done", detail: `${((Date.now() - t0) / 1000).toFixed(1)}s | ${(Number(total) / 1e6).toFixed(2)} USDC` });

      // Step 2
      updateStep(1, { status: "active" });
      onStatus("Broadcasting encrypted transfer...", "info");
      const r1 = await (await token.confidentialTransfer(recipient, encrypted.handles[0], encrypted.inputProof)).wait();
      updateStep(1, { status: "done", txHash: r1.hash, detail: `Gas: ${r1.gasUsed}` });

      // Step 3
      updateStep(2, { status: "active" });
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      let r2: any;
      if (isBatch) {
        r2 = await (await verifier.recordBatchPayment(recipient, nonce, count, pricePerReq)).wait();
      } else {
        r2 = await (await verifier.recordPayment(recipient, nonce, total)).wait();
      }
      updateStep(2, { status: "done", txHash: r2.hash, detail: `Gas: ${r2.gasUsed}` });

      const totalGas = BigInt(r1.gasUsed) + BigInt(r2.gasUsed);
      onStatus(`Payment complete! Gas: ${totalGas}`, "success");
      onTx(isBatch ? "x402 Batch" : "x402 Pay", r1.hash, isBatch ? `${count}x${amount}` : amount);
    } catch (e: any) {
      const fi = steps.findIndex((s) => s.status === "active");
      if (fi >= 0) updateStep(fi, { status: "error", detail: e.reason || e.message });
      onStatus(e.reason || e.message || "Payment failed", "error");
    }
    setRunning(false);
  };

  return (
    <div>
      {/* Payment Form */}
      <div style={card}>
        <div style={cardTitle}>x402 Payment Protocol</div>
        <p style={hint}>Pay for API access using encrypted USDC. The server never sees your balance.</p>

        <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
          {(["single", "batch"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} style={mode === m ? tabAct : tabIn}>
              {m === "single" ? "Single Payment" : "Batch Prepay"}
            </button>
          ))}
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={inputLabel}>Server / Recipient</label>
          <input placeholder="0x..." value={recipient} onChange={(e) => setRecipient(e.target.value)} style={inputStyle} disabled={running} />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={inputLabel}>{mode === "batch" ? "Price per Request" : "Amount"} (USDC)</label>
            <input placeholder="0.10" value={amount} onChange={(e) => setAmount(e.target.value)} style={inputStyle} disabled={running} />
          </div>
          {mode === "batch" && (
            <div style={{ width: 110 }}>
              <label style={inputLabel}>Requests</label>
              <input type="number" value={batchCount} onChange={(e) => setBatchCount(e.target.value)} style={inputStyle} disabled={running} min={1} />
            </div>
          )}
        </div>
        <button onClick={runPayment} disabled={running || !recipient || !amount || !fhevm} style={{ ...btnPrimary, marginTop: 14, width: "100%" }}>
          {running ? "Processing..." : mode === "single" ? "Encrypt & Pay" : `Prepay ${batchCount || 10} Requests`}
        </button>
      </div>

      {/* Progress */}
      {steps.length > 0 && (
        <div style={card}>
          <div style={cardTitle}>Payment Progress</div>
          {steps.map((s, i) => (
            <div key={i} style={stepRow}>
              <span style={{
                fontSize: 14, width: 20, textAlign: "center" as const, paddingTop: 1,
                color: s.status === "done" ? C.success : s.status === "error" ? C.danger : s.status === "active" ? C.warning : "#333",
              }}>
                {s.status === "done" ? "\u2713" : s.status === "error" ? "\u2717" : s.status === "active" ? "\u25CB" : "\u2022"}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{
                  color: s.status === "done" ? C.success : s.status === "error" ? C.danger : s.status === "active" ? C.warning : C.textMuted,
                  fontSize: 12, fontWeight: 500,
                }}>{s.label}</div>
                {s.detail && <div style={{ color: C.textMuted, fontSize: 10, fontFamily: FONT_MONO, marginTop: 2 }}>{s.detail}</div>}
                {s.txHash && (
                  <a href={etherscanTx(s.txHash)} target="_blank" rel="noopener noreferrer" style={link}>
                    {s.txHash.slice(0, 14)}...{s.txHash.slice(-8)}
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* How it works */}
      <div style={card}>
        <div style={cardTitle}>How x402 Works</div>
        {[
          { n: "1", t: "Agent requests API", d: "GET /api/premium-data" },
          { n: "2", t: "Server returns 402", d: "Payment Required: 0.10 cUSDC (fhe-confidential-v1)" },
          { n: "3", t: "Agent encrypts & pays", d: "FHE encryption → confidentialTransfer → recordPayment" },
          { n: "4", t: "Server verifies & responds", d: "On-chain event verification → 200 OK + data" },
        ].map((f, i) => (
          <div key={i} style={flowRow}>
            <span style={flowNum}>{f.n}</span>
            <div>
              <div style={{ color: C.textPrimary, fontSize: 12, fontWeight: 600 }}>{f.t}</div>
              <div style={{ color: C.textMuted, fontSize: 10, fontFamily: FONT_MONO, marginTop: 2 }}>{f.d}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const tabAct: React.CSSProperties = { flex: 1, background: C.gold, color: C.bg, border: "none", borderRadius: 6, padding: "7px 0", cursor: "pointer", fontSize: 11, fontWeight: 700 };
const tabIn: React.CSSProperties = { flex: 1, background: "transparent", color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 0", cursor: "pointer", fontSize: 11 };
const stepRow: React.CSSProperties = { display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 0", borderBottom: `1px solid ${C.bg}` };
const flowRow: React.CSSProperties = { display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 0", borderBottom: `1px solid ${C.bg}` };
const flowNum: React.CSSProperties = {
  background: C.goldFaint, color: C.gold, width: 22, height: 22, borderRadius: "50%",
  display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0,
  border: `1px solid ${C.goldBorder}`,
};
