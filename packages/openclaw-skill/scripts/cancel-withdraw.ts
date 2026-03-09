import { getContracts, ok, fail, parseCliArgs } from "./_wallet.js";

export async function run(_args: Record<string, string>): Promise<string> {
  try {
    const { pool } = await getContracts();
    const tx = await pool.cancelWithdraw();
    const receipt = await tx.wait();

    return ok({
      action: "cancel_withdraw",
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(`Cancel withdrawal failed: ${msg}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cancel-withdraw.ts")) {
  const args = parseCliArgs(process.argv.slice(2));
  run(args).then(console.log);
}
