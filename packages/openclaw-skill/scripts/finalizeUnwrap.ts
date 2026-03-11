import { getContracts, ok, fail, parseCliArgs } from "./_wallet.js";

export async function run(args: Record<string, string>): Promise<string> {
  try {
    const { burntAmount, cleartextAmount, decryptionProof } = args;

    if (!burntAmount || !cleartextAmount || !decryptionProof) {
      return fail("--burntAmount, --cleartextAmount, and --decryptionProof are all required");
    }

    const { token } = await getContracts();

    const tx = await token.finalizeUnwrap(
      burntAmount,
      BigInt(cleartextAmount),
      decryptionProof
    );
    const receipt = await tx.wait();

    return ok({
      action: "unwrap_finalized",
      cleartextAmount,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(`Finalize unwrap failed: ${msg}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("finalizeUnwrap.ts")) {
  const args = parseCliArgs(process.argv.slice(2));
  run(args).then(console.log);
}
