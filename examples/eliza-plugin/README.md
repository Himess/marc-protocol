# FHE x402 Plugin for ElizaOS

Example ElizaOS plugin that adds encrypted USDC payment capabilities to an AI agent.

## Actions

| Action | Description |
|--------|-------------|
| `FHE_PAY` | Access paid API endpoints via `fheFetch` (auto-handles 402 flow) |
| `FHE_BALANCE` | Check public USDC balance and pool initialization status |
| `FHE_DEPOSIT` | Deposit USDC into the FHE encrypted payment pool |

## Usage

```typescript
import { fhePlugin } from "./fhe-plugin";

// Register with ElizaOS
agent.registerPlugin(fhePlugin);
await fhePlugin.initialize();
```

## Environment Variables

```bash
PRIVATE_KEY=0x...           # Agent's private key
SEPOLIA_RPC_URL=https://... # Ethereum Sepolia RPC
```

## Notes

- This is an **example** plugin showing the integration pattern
- Production use requires a real `fhevmjs` instance for amount encryption
- Encrypted balance cannot be read without KMS decryption
- The `FHE_DEPOSIT` action deposits plaintext USDC (it gets encrypted in the pool)
- The `FHE_PAY` action uses `fheFetch` which auto-handles the x402 payment flow
