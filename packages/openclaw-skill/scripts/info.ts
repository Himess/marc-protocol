import { getContracts, ok, fail } from "./_wallet.js";

const DEFAULT_POOL = "0xfF87ec6cb07D8Aa26ABc81037e353A28c7752d73";

export async function run(): Promise<string> {
  try {
    const { signer, provider, pool } = await getContracts();
    const address = await signer.getAddress();
    const ethBalance = await provider.getBalance(address);
    const isInit = await pool.isInitialized(address);

    return ok({
      action: "info",
      network: "Ethereum Sepolia",
      poolAddress: process.env.POOL_ADDRESS || DEFAULT_POOL,
      walletAddress: address,
      ethBalance: ethBalance.toString(),
      isInitialized: isInit,
      scheme: "fhe-confidential-v1",
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(`Info failed: ${msg}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("info.ts")) {
  run().then(console.log);
}
