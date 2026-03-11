import { expect } from "chai";
import hre, { ethers } from "hardhat";

describe("E2E: ConfidentialUSDC + X402PaymentVerifier", function () {
  let token: any;
  let verifier: any;
  let usdc: any;
  let owner: any;
  let alice: any; // payer/agent
  let bob: any; // server/recipient
  let treasury: any;

  // Fee constants matching the contract
  const FEE_BPS = 10n;
  const BPS = 10_000n;
  const MIN_PROTOCOL_FEE = 10_000n; // 0.01 USDC

  function calculateFee(amount: bigint): bigint {
    const percentageFee = (amount * FEE_BPS) / BPS;
    return percentageFee > MIN_PROTOCOL_FEE ? percentageFee : MIN_PROTOCOL_FEE;
  }

  beforeEach(async function () {
    [owner, alice, bob, treasury] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    const Token = await ethers.getContractFactory("ConfidentialUSDC");
    token = await Token.deploy(await usdc.getAddress(), treasury.address);
    await token.waitForDeployment();

    const Verifier = await ethers.getContractFactory("X402PaymentVerifier");
    verifier = await Verifier.deploy(await token.getAddress());
    await verifier.waitForDeployment();
  });

  // 1. Both contracts deploy correctly together
  it("both contracts deploy correctly together", async function () {
    const tokenAddr = await token.getAddress();
    const verifierAddr = await verifier.getAddress();

    expect(tokenAddr).to.be.properAddress;
    expect(verifierAddr).to.be.properAddress;
    expect(tokenAddr).to.not.equal(verifierAddr);

    // Token state
    expect(await token.treasury()).to.equal(treasury.address);
    expect(await token.accumulatedFees()).to.equal(0n);
    expect(await token.FEE_BPS()).to.equal(FEE_BPS);
    expect(await token.MIN_PROTOCOL_FEE()).to.equal(MIN_PROTOCOL_FEE);

    // Verifier trustedToken is the token
    expect(await verifier.trustedToken()).to.equal(tokenAddr);

    // Random nonce is unused
    const randomNonce = ethers.hexlify(ethers.randomBytes(32));
    expect(await verifier.usedNonces(randomNonce)).to.equal(false);
  });

  // 2. Full payment flow: mint USDC -> approve -> wrap -> recordPayment -> verify nonce
  it("full payment flow: mint, approve, wrap, recordPayment, verify nonce", async function () {
    const wrapAmount = 1_000_000n; // 1 USDC
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    // Mint USDC to alice
    await usdc.mint(alice.address, wrapAmount);
    expect(await usdc.balanceOf(alice.address)).to.equal(wrapAmount);

    // Alice approves ConfidentialUSDC to spend her USDC
    await usdc.connect(alice).approve(await token.getAddress(), wrapAmount);

    // Alice wraps USDC into cUSDC
    await token.connect(alice).wrap(alice.address, wrapAmount);

    // USDC transferred from alice to token contract
    expect(await usdc.balanceOf(alice.address)).to.equal(0n);
    expect(await usdc.balanceOf(await token.getAddress())).to.equal(wrapAmount);

    // Fee should be accumulated (0.1% of 1 USDC = 1000 micro-USDC, but min is 10000)
    const expectedFee = calculateFee(wrapAmount);
    expect(await token.accumulatedFees()).to.equal(expectedFee);

    // Record payment on verifier (msg.sender = alice is used as payer)
    await verifier.connect(alice).recordPayment(bob.address, nonce, 1000000n);

    // Nonce is now marked as used
    expect(await verifier.usedNonces(nonce)).to.equal(true);
  });

  // 3. Multiple payments: two wraps + two recordPayments with different nonces
  it("multiple payments: two wraps and two recordPayments with different nonces", async function () {
    const amount1 = 5_000_000n; // 5 USDC
    const amount2 = 10_000_000n; // 10 USDC
    const nonce1 = ethers.hexlify(ethers.randomBytes(32));
    const nonce2 = ethers.hexlify(ethers.randomBytes(32));

    // Mint and wrap for alice (first payment)
    await usdc.mint(alice.address, amount1);
    await usdc.connect(alice).approve(await token.getAddress(), amount1);
    await token.connect(alice).wrap(alice.address, amount1);
    await verifier.connect(alice).recordPayment(bob.address, nonce1, 1000000n);

    // Mint and wrap for alice (second payment)
    await usdc.mint(alice.address, amount2);
    await usdc.connect(alice).approve(await token.getAddress(), amount2);
    await token.connect(alice).wrap(alice.address, amount2);
    await verifier.connect(alice).recordPayment(bob.address, nonce2, 1000000n);

    // Both nonces used
    expect(await verifier.usedNonces(nonce1)).to.equal(true);
    expect(await verifier.usedNonces(nonce2)).to.equal(true);

    // Fees accumulated from both wraps
    const fee1 = calculateFee(amount1);
    const fee2 = calculateFee(amount2);
    expect(await token.accumulatedFees()).to.equal(fee1 + fee2);

    // Total USDC held by token contract
    expect(await usdc.balanceOf(await token.getAddress())).to.equal(amount1 + amount2);
  });

  // 4. Replay prevention: recordPayment with same nonce reverts on second call
  it("replay prevention: same nonce reverts on second recordPayment", async function () {
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    // First call succeeds (msg.sender = alice is payer)
    await expect(verifier.connect(alice).recordPayment(bob.address, nonce, 1000000n))
      .to.emit(verifier, "PaymentVerified")
      .withArgs(alice.address, bob.address, nonce, 1000000n);

    // Second call with same nonce reverts
    await expect(verifier.connect(alice).recordPayment(bob.address, nonce, 1000000n))
      .to.be.revertedWithCustomError(verifier, "NonceAlreadyUsed");

    // Even from a different caller, same nonce still reverts
    await expect(verifier.connect(bob).recordPayment(bob.address, nonce, 1000000n))
      .to.be.revertedWithCustomError(verifier, "NonceAlreadyUsed");
  });

  // 5. Independent wrap + verify: wrapping doesn't affect verifier, verifying doesn't affect token
  it("wrap and verify are independent: neither affects the other", async function () {
    const wrapAmount = 2_000_000n; // 2 USDC
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    // Record payment first (no wrap needed for verifier)
    await verifier.connect(alice).recordPayment(bob.address, nonce, 1000000n);
    expect(await verifier.usedNonces(nonce)).to.equal(true);

    // Token state is unaffected by verifier call
    expect(await token.accumulatedFees()).to.equal(0n);
    expect(await usdc.balanceOf(await token.getAddress())).to.equal(0n);

    // Now wrap (no recordPayment needed for token)
    await usdc.mint(alice.address, wrapAmount);
    await usdc.connect(alice).approve(await token.getAddress(), wrapAmount);
    await token.connect(alice).wrap(alice.address, wrapAmount);

    // Token has fees, but verifier state hasn't changed
    expect(await token.accumulatedFees()).to.equal(calculateFee(wrapAmount));
    // No new nonces were marked (only the one from before)
    const freshNonce = ethers.hexlify(ethers.randomBytes(32));
    expect(await verifier.usedNonces(freshNonce)).to.equal(false);
  });

  // 6. Fee accumulation across payments: wrap multiple times, check total accumulatedFees
  it("fee accumulation across multiple wraps", async function () {
    const amounts = [100_000n, 500_000n, 1_000_000n, 50_000_000n, 200_000_000n];
    let totalFees = 0n;
    let totalWrapped = 0n;

    for (const amount of amounts) {
      await usdc.mint(alice.address, amount);
      await usdc.connect(alice).approve(await token.getAddress(), amount);
      await token.connect(alice).wrap(alice.address, amount);

      totalFees += calculateFee(amount);
      totalWrapped += amount;
    }

    // All fees accumulated correctly
    expect(await token.accumulatedFees()).to.equal(totalFees);

    // All USDC held by token
    expect(await usdc.balanceOf(await token.getAddress())).to.equal(totalWrapped);

    // Verify individual fee calculations (amounts are in micro-USDC, 6 decimals):
    // 0.1 USDC  (100_000)     -> percentageFee = 100_000 * 10 / 10000 = 100     -> max(100, 10000) = 10_000 (min fee)
    // 0.5 USDC  (500_000)     -> percentageFee = 500_000 * 10 / 10000 = 500     -> max(500, 10000) = 10_000 (min fee)
    // 1 USDC    (1_000_000)   -> percentageFee = 1_000_000 * 10 / 10000 = 1000  -> max(1000, 10000) = 10_000 (min fee)
    // 50 USDC   (50_000_000)  -> percentageFee = 50_000_000 * 10 / 10000 = 50000 -> max(50000, 10000) = 50_000 (percentage)
    // 200 USDC  (200_000_000) -> percentageFee = 200_000_000 * 10 / 10000 = 200000 -> max(200000, 10000) = 200_000 (percentage)
    expect(totalFees).to.equal(10_000n + 10_000n + 10_000n + 50_000n + 200_000n);
  });

  // 7. Treasury withdrawal after payments: wrap -> accumulatedFees > 0 -> treasuryWithdraw -> fees sent to treasury
  it("treasury withdrawal after payments", async function () {
    const wrapAmount = 500_000_000n; // 500 USDC
    const expectedFee = calculateFee(wrapAmount); // 50_000 (0.1% of 500 USDC)

    // Mint, approve, and wrap
    await usdc.mint(alice.address, wrapAmount);
    await usdc.connect(alice).approve(await token.getAddress(), wrapAmount);
    await token.connect(alice).wrap(alice.address, wrapAmount);

    expect(await token.accumulatedFees()).to.equal(expectedFee);

    // Treasury USDC balance before withdrawal
    const treasuryBalBefore = await usdc.balanceOf(treasury.address);

    // Treasury withdraws fees
    await expect(token.connect(treasury).treasuryWithdraw())
      .to.emit(token, "TreasuryWithdrawn")
      .withArgs(treasury.address, expectedFee);

    // Fees reset to zero
    expect(await token.accumulatedFees()).to.equal(0n);

    // Treasury received the fees in USDC
    const treasuryBalAfter = await usdc.balanceOf(treasury.address);
    expect(treasuryBalAfter - treasuryBalBefore).to.equal(expectedFee);

    // Token contract still holds the rest (wrapAmount - fee)
    expect(await usdc.balanceOf(await token.getAddress())).to.equal(wrapAmount - expectedFee);

    // Calling treasuryWithdraw again with 0 fees reverts
    await expect(token.connect(treasury).treasuryWithdraw())
      .to.be.revertedWithCustomError(token, "InsufficientFees");
  });

  // 8. Different payers and servers: multiple agents wrap and make payments to different servers
  it("different payers and servers: multiple agents and servers interact independently", async function () {
    const amount = 10_000_000n; // 10 USDC each
    const nonceAliceToBob = ethers.hexlify(ethers.randomBytes(32));
    const nonceBobToAlice = ethers.hexlify(ethers.randomBytes(32));
    const nonceOwnerToBob = ethers.hexlify(ethers.randomBytes(32));

    // Alice wraps and pays Bob (msg.sender = alice is payer)
    await usdc.mint(alice.address, amount);
    await usdc.connect(alice).approve(await token.getAddress(), amount);
    await token.connect(alice).wrap(alice.address, amount);
    await expect(verifier.connect(alice).recordPayment(bob.address, nonceAliceToBob, 1000000n))
      .to.emit(verifier, "PaymentVerified")
      .withArgs(alice.address, bob.address, nonceAliceToBob, 1000000n);

    // Bob wraps and pays Alice (msg.sender = bob is payer)
    await usdc.mint(bob.address, amount);
    await usdc.connect(bob).approve(await token.getAddress(), amount);
    await token.connect(bob).wrap(bob.address, amount);
    await expect(verifier.connect(bob).recordPayment(alice.address, nonceBobToAlice, 1000000n))
      .to.emit(verifier, "PaymentVerified")
      .withArgs(bob.address, alice.address, nonceBobToAlice, 1000000n);

    // Owner wraps and pays Bob (msg.sender = owner is payer)
    await usdc.mint(owner.address, amount);
    await usdc.connect(owner).approve(await token.getAddress(), amount);
    await token.connect(owner).wrap(owner.address, amount);
    await expect(verifier.connect(owner).recordPayment(bob.address, nonceOwnerToBob, 1000000n))
      .to.emit(verifier, "PaymentVerified")
      .withArgs(owner.address, bob.address, nonceOwnerToBob, 1000000n);

    // All nonces used
    expect(await verifier.usedNonces(nonceAliceToBob)).to.equal(true);
    expect(await verifier.usedNonces(nonceBobToAlice)).to.equal(true);
    expect(await verifier.usedNonces(nonceOwnerToBob)).to.equal(true);

    // Three wraps worth of fees accumulated
    const feePerWrap = calculateFee(amount);
    expect(await token.accumulatedFees()).to.equal(feePerWrap * 3n);

    // Token holds all three deposits
    expect(await usdc.balanceOf(await token.getAddress())).to.equal(amount * 3n);
  });

  // 9. Pause doesn't affect verifier: pause token -> recordPayment still works
  it("pausing token does not affect verifier", async function () {
    const wrapAmount = 1_000_000n; // 1 USDC
    const nonceBefore = ethers.hexlify(ethers.randomBytes(32));
    const nonceDuring = ethers.hexlify(ethers.randomBytes(32));
    const nonceAfter = ethers.hexlify(ethers.randomBytes(32));

    // Wrap before pause
    await usdc.mint(alice.address, wrapAmount);
    await usdc.connect(alice).approve(await token.getAddress(), wrapAmount);
    await token.connect(alice).wrap(alice.address, wrapAmount);
    await verifier.connect(alice).recordPayment(bob.address, nonceBefore, 1000000n);

    // Owner pauses token
    await token.connect(owner).pause();

    // Wrapping reverts while paused
    await usdc.mint(alice.address, wrapAmount);
    await usdc.connect(alice).approve(await token.getAddress(), wrapAmount);
    await expect(token.connect(alice).wrap(alice.address, wrapAmount))
      .to.be.revertedWithCustomError(token, "EnforcedPause");

    // But verifier still works fine while token is paused
    await expect(verifier.connect(alice).recordPayment(bob.address, nonceDuring, 1000000n))
      .to.emit(verifier, "PaymentVerified")
      .withArgs(alice.address, bob.address, nonceDuring, 1000000n);
    expect(await verifier.usedNonces(nonceDuring)).to.equal(true);

    // Unpause and verify both contracts work again
    await token.connect(owner).unpause();
    await token.connect(alice).wrap(alice.address, wrapAmount);
    await verifier.connect(alice).recordPayment(bob.address, nonceAfter, 1000000n);
    expect(await verifier.usedNonces(nonceAfter)).to.equal(true);
  });

  // 10. E2E batch payment flow: mint -> wrap -> recordBatchPayment -> verify nonce + event
  it("batch payment flow: mint, wrap, recordBatchPayment, verify nonce and event", async function () {
    const wrapAmount = 10_000_000n; // 10 USDC
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const requestCount = 10;
    const pricePerRequest = 1_000_000n; // 1 USDC per request

    // Mint USDC to alice
    await usdc.mint(alice.address, wrapAmount);
    expect(await usdc.balanceOf(alice.address)).to.equal(wrapAmount);

    // Alice approves and wraps USDC into cUSDC
    await usdc.connect(alice).approve(await token.getAddress(), wrapAmount);
    await token.connect(alice).wrap(alice.address, wrapAmount);

    // USDC transferred from alice to token contract
    expect(await usdc.balanceOf(alice.address)).to.equal(0n);
    expect(await usdc.balanceOf(await token.getAddress())).to.equal(wrapAmount);

    // Fee accumulated
    const expectedFee = calculateFee(wrapAmount);
    expect(await token.accumulatedFees()).to.equal(expectedFee);

    // Alice calls recordBatchPayment on verifier
    await expect(
      verifier.connect(alice).recordBatchPayment(bob.address, nonce, requestCount, pricePerRequest)
    )
      .to.emit(verifier, "BatchPaymentRecorded")
      .withArgs(alice.address, bob.address, nonce, requestCount, pricePerRequest);

    // Nonce is now marked as used
    expect(await verifier.usedNonces(nonce)).to.equal(true);

    // Replay reverts
    await expect(
      verifier.connect(alice).recordBatchPayment(bob.address, nonce, requestCount, pricePerRequest)
    ).to.be.revertedWithCustomError(verifier, "NonceAlreadyUsed");
  });

  // 11. System state consistency: wrap amounts + fees + balances all add up correctly
  it("system state consistency: wrap amounts, fees, and balances add up", async function () {
    const amounts = [
      { user: alice, amount: 1_000_000n }, // 1 USDC (min fee)
      { user: bob, amount: 50_000_000n }, // 50 USDC (min fee)
      { user: alice, amount: 200_000_000n }, // 200 USDC (percentage fee: 20000)
      { user: bob, amount: 1_000_000_000n }, // 1000 USDC (percentage fee: 100000)
      { user: owner, amount: 100_000n }, // 0.1 USDC (min fee)
    ];

    let totalDeposited = 0n;
    let totalExpectedFees = 0n;
    const nonces: string[] = [];

    for (const { user, amount } of amounts) {
      await usdc.mint(user.address, amount);
      await usdc.connect(user).approve(await token.getAddress(), amount);
      await token.connect(user).wrap(user.address, amount);

      const nonce = ethers.hexlify(ethers.randomBytes(32));
      await verifier.connect(user).recordPayment(bob.address, nonce, 1000000n);
      nonces.push(nonce);

      totalDeposited += amount;
      totalExpectedFees += calculateFee(amount);
    }

    // Invariant 1: accumulated fees match expected
    const actualFees = await token.accumulatedFees();
    expect(actualFees).to.equal(totalExpectedFees);

    // Invariant 2: token contract holds ALL deposited USDC (fees are still in the contract)
    const tokenUsdcBalance = await usdc.balanceOf(await token.getAddress());
    expect(tokenUsdcBalance).to.equal(totalDeposited);

    // Invariant 3: all nonces are marked used
    for (const nonce of nonces) {
      expect(await verifier.usedNonces(nonce)).to.equal(true);
    }

    // Invariant 4: treasury withdraw drains exactly the accumulated fees
    const treasuryBefore = await usdc.balanceOf(treasury.address);
    await token.connect(treasury).treasuryWithdraw();
    const treasuryAfter = await usdc.balanceOf(treasury.address);

    expect(treasuryAfter - treasuryBefore).to.equal(totalExpectedFees);
    expect(await token.accumulatedFees()).to.equal(0n);

    // Invariant 5: token contract now holds totalDeposited - fees
    const tokenBalanceAfterWithdraw = await usdc.balanceOf(await token.getAddress());
    expect(tokenBalanceAfterWithdraw).to.equal(totalDeposited - totalExpectedFees);

    // Invariant 6: all balances across the system add up to total minted
    // Total USDC minted = totalDeposited (all went to alice/bob/owner then to token contract)
    // After treasury withdraw: token holds (totalDeposited - fees), treasury holds fees
    // alice/bob/owner hold 0 USDC (all wrapped)
    const aliceUsdc = await usdc.balanceOf(alice.address);
    const bobUsdc = await usdc.balanceOf(bob.address);
    const ownerUsdc = await usdc.balanceOf(owner.address);
    expect(aliceUsdc + bobUsdc + ownerUsdc + tokenBalanceAfterWithdraw + (treasuryAfter - treasuryBefore))
      .to.equal(totalDeposited);
  });
});
