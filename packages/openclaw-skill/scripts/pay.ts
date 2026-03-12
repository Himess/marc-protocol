import { ethers } from "ethers";
import { getContracts, getTokenAddress, ok, fail, parseAmount, parseCliArgs } from "./_wallet.js";

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

    const { token, verifier, signer, fhevmInstance } = await getContracts();
    const signerAddress = await signer.getAddress();
    const tokenAddress = getTokenAddress();

    // Encrypt amount using @zama-fhe/relayer-sdk (use tokenAddress for encrypted input)
    const input = fhevmInstance.createEncryptedInput(tokenAddress, signerAddress);
    input.add64(rawAmount);
    const encrypted = await input.encrypt();

    // Generate random nonce
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    // Confidential transfer via token contract
    const tx = await token.confidentialTransfer(to, encrypted.handles[0], encrypted.inputProof);
    const receipt = await tx.wait();

    // Record payment on verifier contract
    const verifierTx = await verifier.recordPayment(to, nonce, rawAmount);
    const verifierReceipt = await verifierTx.wait();

    return ok({
      action: "pay",
      to,
      amount: amountStr,
      txHash: receipt.hash,
      verifierTxHash: verifierReceipt.hash,
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
