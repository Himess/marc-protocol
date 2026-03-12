import { getContracts, getTokenAddress, ok, fail, parseCliArgs, parseAmount } from "./_wallet.js";

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

    const { token, signer, fhevmInstance } = await getContracts();
    const signerAddress = await signer.getAddress();
    const tokenAddress = getTokenAddress();

    // Encrypt unwrap amount using @zama-fhe/relayer-sdk
    const input = fhevmInstance.createEncryptedInput(tokenAddress, signerAddress);
    input.add64(rawAmount);
    const encrypted = await input.encrypt();

    // Unwrap cUSDC -> USDC (2-step: request then KMS finalizes)
    const tx = await token.unwrap(signerAddress, signerAddress, encrypted.handles[0], encrypted.inputProof);
    const receipt = await tx.wait();

    return ok({
      action: "unwrap_requested",
      amount: amountStr,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      note: "Step 1 complete. Step 2 (finalize) requires async KMS callback.",
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(`Unwrap failed: ${msg}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("unwrap.ts")) {
  const args = parseCliArgs(process.argv.slice(2));
  run(args).then(console.log);
}
