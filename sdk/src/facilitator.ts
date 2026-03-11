import crypto from "crypto";

/** Constant-time string comparison to prevent timing attacks */
function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export interface FacilitatorConfig {
  tokenAddress: string;
  verifierAddress: string;
  rpcUrl: string;
  name?: string;
  version?: string;
  apiKey?: string;
  chainId?: number;
}

const TOKEN_EVENT_ABI = [
  "event ConfidentialTransfer(address indexed from, address indexed to, bytes32 indexed amount)",
];

const VERIFIER_EVENT_ABI = [
  "event PaymentVerified(address indexed payer, address indexed server, bytes32 indexed nonce)",
];

/**
 * Create a facilitator Express app with x402-standard endpoints.
 * V4.0: Verifies ConfidentialTransfer + PaymentVerified events on-chain.
 *
 * Usage:
 *   const app = await createFacilitatorServer({
 *     tokenAddress: '0x...',
 *     verifierAddress: '0x...',
 *     rpcUrl: 'https://sepolia.infura.io/v3/...',
 *   });
 *   app.listen(3001);
 */
export async function createFacilitatorServer(config: FacilitatorConfig): Promise<any> {
  // Dynamic import to avoid bundling express as hard dependency
  const expressModule = await import("express");
  const express = expressModule.default ?? expressModule;
  const app = express();
  app.use(express.json({ limit: "100kb" }));

  const chainId = config.chainId ?? 11155111;
  const network = `eip155:${chainId}`;

  // API key authentication middleware
  if (!config.apiKey) {
    console.warn("[fhe-x402] WARNING: No API key configured. Facilitator endpoints are unauthenticated.");
  }
  if (config.apiKey) {
    app.use((req: any, res: any, nextFn: any) => {
      if (req.path === "/health" || req.path === "/info") return nextFn();
      const key =
        req.headers["x-fhe-x402-api-key"] ||
        req.headers["authorization"]?.replace("Bearer ", "");
      if (!key || !timingSafeCompare(key, config.apiKey!)) {
        return res.status(401).json({ valid: false, error: "Unauthorized: invalid API key" });
      }
      nextFn();
    });
  }

  // Lazy-init provider
  let _provider: any = null;

  async function getProvider() {
    if (!_provider) {
      const { ethers } = await import("ethers");
      _provider = new ethers.JsonRpcProvider(config.rpcUrl);
    }
    return _provider;
  }

  // === x402 Standard Endpoints ===

  app.get("/info", (_req: any, res: any) => {
    res.json({
      name: config.name || "FHE x402 Facilitator",
      version: config.version || "4.0.0",
      schemes: ["fhe-confidential-v1"],
      networks: [network],
      tokens: ["USDC"],
      protocolFee: "0.1%",
      minFee: "10000",
      features: [
        "fhe-encrypted-amounts",
        "token-centric",
        "fee-free-transfers",
        "event-verification",
      ],
    });
  });

  // /verify — verify ConfidentialTransfer + PaymentVerified events on-chain
  app.post("/verify", async (req: any, res: any) => {
    try {
      const { x402Version, scheme, network: reqNetwork, payload } = req.body;

      if (scheme !== "fhe-confidential-v1") {
        return res.status(400).json({
          valid: false,
          error: `Unsupported scheme: ${scheme}. Use fhe-confidential-v1`,
        });
      }

      if (!reqNetwork) {
        return res.status(400).json({ error: "Missing network field" });
      }

      if (reqNetwork !== network) {
        return res.status(400).json({
          valid: false,
          error: `Unsupported network: ${reqNetwork}`,
        });
      }

      if (!payload || !payload.txHash) {
        return res.status(400).json({
          valid: false,
          error: "Missing payload or txHash",
        });
      }

      const provider = await getProvider();
      const { ethers } = await import("ethers");

      const receipt = await provider.getTransactionReceipt(payload.txHash);
      if (!receipt || receipt.status === 0) {
        return res.status(400).json({
          valid: false,
          error: "Transaction failed or not found",
        });
      }

      // Verify ConfidentialTransfer event
      const tokenIface = new ethers.Interface(TOKEN_EVENT_ABI);
      let verified = false;
      let eventFrom = "";
      let eventTo = "";

      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== config.tokenAddress.toLowerCase()) continue;
        try {
          const parsed = tokenIface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "ConfidentialTransfer") {
            verified = true;
            eventFrom = parsed.args[0];
            eventTo = parsed.args[1];
            break;
          }
        } catch {
          continue;
        }
      }

      if (!verified) {
        return res.status(400).json({
          valid: false,
          error: "ConfidentialTransfer event not found in transaction",
        });
      }

      res.json({
        valid: true,
        x402Version: x402Version || 1,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        network: reqNetwork || network,
        from: eventFrom,
        to: eventTo,
        settledAt: new Date().toISOString(),
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ valid: false, error: msg });
    }
  });

  app.get("/health", (_req: any, res: any) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  return app;
}
