import { ethers } from "ethers";
import { getContracts, getPoolAddress, ok, fail, parseAmount, parseCliArgs } from "./_wallet.js";

export async function run(args: Record<string, string>): Promise<string> {
  try {
    const amountStr = args.amount;
    const to = args.to;

    if (!amountStr || !to) {
      return fail("Both --amount and --to are required");
    }

    if (!/^0x[a-fA-F0-9]{40}$/.test(to)) {
      return fail("Invalid Ethereum address format");
    }

    let rawAmount: bigint;
    try {
      rawAmount = parseAmount(amountStr);
    } catch {
      return fail("Invalid amount. Must be a positive number.");
    }

    const { pool, signer, fhevmInstance } = await getContracts();
    const signerAddress = await signer.getAddress();
    const poolAddress = getPoolAddress();

    // Encrypt amount using fhevmjs
    const input = fhevmInstance.createEncryptedInput(poolAddress, signerAddress);
    input.add64(rawAmount);
    const encrypted = await input.encrypt();

    // Generate random nonce
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    const tx = await pool.pay(
      to,
      encrypted.handles[0],
      encrypted.inputProof,
      rawAmount,
      nonce,
      ethers.ZeroHash
    );
    const receipt = await tx.wait();

    return ok({
      action: "pay",
      to,
      amount: amountStr,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      nonce,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(`Payment failed: ${msg}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("pay.ts")) {
  const args = parseCliArgs(process.argv.slice(2));
  run(args).then(console.log);
}
