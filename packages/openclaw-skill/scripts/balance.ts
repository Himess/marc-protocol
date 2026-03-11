import { getContracts, ok, fail, formatUSDC } from "./_wallet.js";

export async function run(): Promise<string> {
  try {
    const { usdc, token, signer } = await getContracts();
    const address = await signer.getAddress();

    const publicBalance: bigint = await usdc.balanceOf(address);

    // Get encrypted balance handle (non-zero means user has cUSDC)
    let encryptedBalanceHandle = "0x" + "00".repeat(32);
    try {
      encryptedBalanceHandle = await token.confidentialBalanceOf(address);
    } catch { /* may not be available */ }

    const hasEncryptedBalance = encryptedBalanceHandle !== "0x" + "00".repeat(32);

    return ok({
      action: "balance",
      walletAddress: address,
      publicBalance: publicBalance.toString(),
      publicBalanceUSDC: formatUSDC(publicBalance),
      hasEncryptedBalance,
      encryptedBalanceHandle,
      note: hasEncryptedBalance
        ? "Encrypted cUSDC balance exists. Exact amount requires KMS decryption."
        : "No encrypted cUSDC balance detected.",
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(`Balance check failed: ${msg}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("balance.ts")) {
  run().then(console.log);
}
