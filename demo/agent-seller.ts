/**
 * FHE x402 Agent Seller — Express server selling API data behind FHE paywall.
 *
 * Usage: npx tsx demo/agent-seller.ts
 * Requires: PRIVATE_KEY env var (for recipient address)
 */

import { fhePaywall } from "fhe-x402-sdk";

const PORT = parseInt(process.env.PORT || "3001", 10);
const POOL_ADDRESS = "0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73";
const RPC_URL = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const RECIPIENT = process.env.RECIPIENT_ADDRESS || "0xF505e2E71df58D7244189072008f25f6b6aaE5ae";

async function main() {
  // Dynamic import to avoid requiring express as hard dependency
  const expressModule = await import("express");
  const express = expressModule.default ?? expressModule;
  const app = express();

  console.log(`[Seller] Starting FHE x402 API server...`);
  console.log(`[Seller] Pool: ${POOL_ADDRESS}`);
  console.log(`[Seller] Recipient: ${RECIPIENT}`);
  console.log(`[Seller] RPC: ${RPC_URL}`);
  console.log();

  // Public endpoint — no payment required
  app.get("/api/public", (_req: any, res: any) => {
    res.json({
      message: "This is free, public data.",
      timestamp: new Date().toISOString(),
    });
  });

  // Premium endpoint — FHE x402 paywall
  app.use(
    "/api/premium",
    fhePaywall({
      price: "1000000", // 1 USDC
      asset: "USDC",
      poolAddress: POOL_ADDRESS,
      recipientAddress: RECIPIENT,
      rpcUrl: RPC_URL,
      chainId: 11155111,
      minConfirmations: 1,
    })
  );

  app.get("/api/premium/data", (req: any, res: any) => {
    res.json({
      message: "Premium API data — you paid with encrypted USDC!",
      paidBy: req.paymentInfo?.from,
      txHash: req.paymentInfo?.txHash,
      timestamp: new Date().toISOString(),
      secretData: {
        marketSignal: "bullish",
        confidence: 0.87,
        source: "FHE x402 Premium Feed",
      },
    });
  });

  app.get("/api/premium/analysis", (req: any, res: any) => {
    res.json({
      message: "Premium analysis endpoint",
      paidBy: req.paymentInfo?.from,
      analysis: {
        trend: "upward",
        volatility: "low",
        recommendation: "hold",
      },
    });
  });

  // Health check
  app.get("/health", (_req: any, res: any) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.listen(PORT, () => {
    console.log(`[Seller] Server running on http://localhost:${PORT}`);
    console.log(`[Seller] Public:  GET http://localhost:${PORT}/api/public`);
    console.log(`[Seller] Premium: GET http://localhost:${PORT}/api/premium/data (1 USDC)`);
    console.log(`[Seller] Premium: GET http://localhost:${PORT}/api/premium/analysis (1 USDC)`);
    console.log(`[Seller] Health:  GET http://localhost:${PORT}/health`);
    console.log();
    console.log(`[Seller] Waiting for payments...`);
  });
}

main().catch(console.error);
