import { getContracts, ok, fail, parseAmount, parseCliArgs } from "./_wallet.js";

export async function run(args: Record<string, string>): Promise<string> {
  try {
    const amountStr = args.amount;
    if (!amountStr) {
      return fail("--amount is required");
    }

    let rawAmount: bigint;
    try {
      rawAmount = parseAmount(amountStr);
    } catch {
      return fail("Invalid amount. Must be a positive number.");
    }

    const { pool, usdc } = await getContracts();

    // Approve USDC
    const approveTx = await usdc.approve(await pool.getAddress(), rawAmount);
    await approveTx.wait();

    // Deposit
    const tx = await pool.deposit(rawAmount);
    const receipt = await tx.wait();

    return ok({
      action: "deposit",
      amount: amountStr,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(`Deposit failed: ${msg}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("deposit.ts")) {
  const args = parseCliArgs(process.argv.slice(2));
  run(args).then(console.log);
}
