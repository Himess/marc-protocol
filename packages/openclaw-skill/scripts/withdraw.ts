import { getContracts, getPoolAddress, ok, fail, parseCliArgs } from "./_wallet.js";

export async function run(args: Record<string, string>): Promise<string> {
  try {
    const amountStr = args.amount;
    if (!amountStr) {
      return fail("--amount is required");
    }

    const amountFloat = parseFloat(amountStr);
    if (isNaN(amountFloat) || amountFloat <= 0) {
      return fail("Invalid amount. Must be a positive number.");
    }
    const rawAmount = BigInt(Math.round(amountFloat * 1_000_000));

    const { pool, signer, fhevmInstance } = await getContracts();
    const signerAddress = await signer.getAddress();
    const poolAddress = getPoolAddress();

    // Encrypt withdrawal amount using fhevmjs
    const input = fhevmInstance.createEncryptedInput(poolAddress, signerAddress);
    input.add64(rawAmount);
    const encrypted = await input.encrypt();

    const tx = await pool.requestWithdraw(
      encrypted.handles[0],
      encrypted.inputProof
    );
    const receipt = await tx.wait();

    return ok({
      action: "withdraw_requested",
      amount: amountStr,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      note: "Step 1 complete. Step 2 (finalize) requires async KMS callback.",
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(`Withdrawal request failed: ${msg}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("withdraw.ts")) {
  const args = parseCliArgs(process.argv.slice(2));
  run(args).then(console.log);
}
