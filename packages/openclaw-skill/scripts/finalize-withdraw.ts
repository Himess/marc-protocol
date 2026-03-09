import { getContracts, ok, fail, parseCliArgs } from "./_wallet.js";

export async function run(args: Record<string, string>): Promise<string> {
  try {
    const clearAmountStr = args.clearAmount || args["clear-amount"];
    const proof = args.proof || args.decryptionProof;

    if (!clearAmountStr || !proof) {
      return fail("Both --clear-amount and --proof are required");
    }

    const clearAmount = parseInt(clearAmountStr);
    if (isNaN(clearAmount) || clearAmount < 0) {
      return fail("Invalid clear-amount. Must be a non-negative integer.");
    }

    const { pool } = await getContracts();
    const tx = await pool.finalizeWithdraw(clearAmount, proof);
    const receipt = await tx.wait();

    const amountUSDC = (clearAmount / 1_000_000).toFixed(2);

    return ok({
      action: "finalize_withdraw",
      amount: amountUSDC,
      clearAmount: clearAmountStr,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(`Finalize withdrawal failed: ${msg}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("finalize-withdraw.ts")) {
  const args = parseCliArgs(process.argv.slice(2));
  run(args).then(console.log);
}
