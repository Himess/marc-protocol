import { expect } from "chai";
import { ethers } from "hardhat";

describe("X402PaymentVerifier", function () {
  let verifier: any;
  let payer: any;
  let server: any;
  let other: any;
  let trustedToken: any;

  beforeEach(async function () {
    [payer, server, other, trustedToken] = await ethers.getSigners();
    const Verifier = await ethers.getContractFactory("X402PaymentVerifier");
    verifier = await Verifier.deploy(trustedToken.address);
    await verifier.waitForDeployment();
  });

  it("deploys correctly", async function () {
    const address = await verifier.getAddress();
    expect(address).to.be.properAddress;
  });

  it("sets trustedToken on deploy", async function () {
    expect(await verifier.trustedToken()).to.equal(trustedToken.address);
  });

  it("recordPayment emits PaymentVerified event", async function () {
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    await expect(verifier.connect(payer).recordPayment(server.address, nonce, 1000000n))
      .to.emit(verifier, "PaymentVerified");
  });

  it("recordPayment marks nonce as used", async function () {
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    await verifier.connect(payer).recordPayment(server.address, nonce, 1000000n);
    expect(await verifier.usedNonces(nonce)).to.equal(true);
  });

  it("recordPayment reverts on duplicate nonce", async function () {
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    await verifier.connect(payer).recordPayment(server.address, nonce, 1000000n);
    await expect(verifier.connect(payer).recordPayment(server.address, nonce, 1000000n))
      .to.be.revertedWithCustomError(verifier, "NonceAlreadyUsed");
  });

  it("different nonces work independently", async function () {
    const nonce1 = ethers.hexlify(ethers.randomBytes(32));
    const nonce2 = ethers.hexlify(ethers.randomBytes(32));

    await verifier.connect(payer).recordPayment(server.address, nonce1, 1000000n);
    await verifier.connect(payer).recordPayment(server.address, nonce2, 1000000n);

    expect(await verifier.usedNonces(nonce1)).to.equal(true);
    expect(await verifier.usedNonces(nonce2)).to.equal(true);
  });

  it("anyone can call recordPayment (permissionless)", async function () {
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    await expect(verifier.connect(other).recordPayment(server.address, nonce, 1000000n))
      .to.not.be.reverted;
  });

  it("event contains correct payer (msg.sender), server, nonce", async function () {
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    await expect(verifier.connect(payer).recordPayment(server.address, nonce, 1000000n))
      .to.emit(verifier, "PaymentVerified")
      .withArgs(payer.address, server.address, nonce, 1000000n);
  });

  it("usedNonces returns false for unused nonce", async function () {
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    expect(await verifier.usedNonces(nonce)).to.equal(false);
  });

  it("multiple payments from same payer work", async function () {
    const nonce1 = ethers.hexlify(ethers.randomBytes(32));
    const nonce2 = ethers.hexlify(ethers.randomBytes(32));
    const nonce3 = ethers.hexlify(ethers.randomBytes(32));

    await verifier.connect(payer).recordPayment(server.address, nonce1, 1000000n);
    await verifier.connect(payer).recordPayment(other.address, nonce2, 1000000n);
    await verifier.connect(payer).recordPayment(server.address, nonce3, 1000000n);

    expect(await verifier.usedNonces(nonce1)).to.equal(true);
    expect(await verifier.usedNonces(nonce2)).to.equal(true);
    expect(await verifier.usedNonces(nonce3)).to.equal(true);
  });

  it("multiple payments to same server work", async function () {
    const nonce1 = ethers.hexlify(ethers.randomBytes(32));
    const nonce2 = ethers.hexlify(ethers.randomBytes(32));
    const nonce3 = ethers.hexlify(ethers.randomBytes(32));

    await verifier.connect(payer).recordPayment(server.address, nonce1, 1000000n);
    await verifier.connect(other).recordPayment(server.address, nonce2, 1000000n);
    await verifier.connect(payer).recordPayment(server.address, nonce3, 1000000n);

    expect(await verifier.usedNonces(nonce1)).to.equal(true);
    expect(await verifier.usedNonces(nonce2)).to.equal(true);
    expect(await verifier.usedNonces(nonce3)).to.equal(true);
  });

  // =========================================================================
  // V4.4 — payAndRecord trustedToken guard
  // =========================================================================

  it("payAndRecord reverts with untrusted token", async function () {
    // Call payAndRecord with an address that is NOT the trustedToken
    // Should revert with UntrustedCaller
    await expect(
      verifier.connect(payer).payAndRecord(
        server.address, // NOT trustedToken
        other.address, // server
        ethers.hexlify(ethers.randomBytes(32)), // nonce
        1000000, // minPrice
        ethers.hexlify(ethers.randomBytes(32)), // fake encrypted amount
        "0x" // fake proof
      )
    ).to.be.revertedWithCustomError(verifier, "UntrustedCaller");
  });

  // =========================================================================
  // V4.4 — recordPayment zero minPrice guard
  // =========================================================================

  it("recordPayment reverts on zero minPrice", async function () {
    await expect(
      verifier.connect(payer).recordPayment(server.address, ethers.hexlify(ethers.randomBytes(32)), 0)
    ).to.be.revertedWithCustomError(verifier, "ZeroMinPrice");
  });

  // =========================================================================
  // V4.4 — recordPayment uses msg.sender as payer
  // =========================================================================

  it("recordPayment uses msg.sender as payer", async function () {
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    // Call from 'other' — the event should have other.address as payer, not payer.address
    await expect(verifier.connect(other).recordPayment(server.address, nonce, 1000000n))
      .to.emit(verifier, "PaymentVerified")
      .withArgs(other.address, server.address, nonce, 1000000n);
  });

  it("nonce griefing: attacker cannot record nonce for different payer", async function () {
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    // Attacker calls recordPayment — the payer in the event is the attacker (msg.sender), not the victim
    await verifier.connect(other).recordPayment(server.address, nonce, 1000000n);

    // The event recorded other.address as payer, NOT payer.address
    // So payer can still record their own payment with the same server and price
    // (but a different nonce since nonce is globally unique)
    const nonce2 = ethers.hexlify(ethers.randomBytes(32));
    await expect(verifier.connect(payer).recordPayment(server.address, nonce2, 1000000n))
      .to.emit(verifier, "PaymentVerified")
      .withArgs(payer.address, server.address, nonce2, 1000000n);
  });

  // =========================================================================
  // V4.4 — onConfidentialTransferReceived trustedToken check
  // =========================================================================

  it("onConfidentialTransferReceived reverts from untrusted token", async function () {
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const data = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes32", "uint64"],
      [server.address, nonce, 1000000n]
    );

    // Call from 'other' (not trustedToken) — should revert with UntrustedCaller
    // IERC7984Receiver signature: (operator, from, euint64 amount, data)
    await expect(
      verifier.connect(other).onConfidentialTransferReceived(
        payer.address,
        payer.address,
        ethers.zeroPadValue("0x01", 32),
        data
      )
    ).to.be.revertedWithCustomError(verifier, "UntrustedCaller");
  });

  it("onConfidentialTransferReceived reverts with malformed data", async function () {
    // Call from trustedToken but with data that can't be decoded as (address, bytes32, uint64)
    const malformedData = "0xdeadbeef";

    await expect(
      verifier.connect(trustedToken).onConfidentialTransferReceived(
        payer.address,
        payer.address,
        ethers.zeroPadValue("0x01", 32),
        malformedData
      )
    ).to.be.reverted; // abi.decode will revert
  });

  it("onConfidentialTransferReceived records nonce when called from trustedToken", async function () {
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const data = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes32", "uint64"],
      [server.address, nonce, 1000000n]
    );

    // Call from trustedToken — should succeed
    await expect(
      verifier.connect(trustedToken).onConfidentialTransferReceived(
        payer.address,
        payer.address,
        ethers.zeroPadValue("0x01", 32),
        data
      )
    ).to.emit(verifier, "PaymentVerified")
      .withArgs(payer.address, server.address, nonce, 1000000n);

    // Nonce should be marked as used
    expect(await verifier.usedNonces(nonce)).to.equal(true);
  });

  it("onConfidentialTransferReceived rejects duplicate nonce from trustedToken", async function () {
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const data = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes32", "uint64"],
      [server.address, nonce, 1000000n]
    );

    // First call succeeds
    await verifier.connect(trustedToken).onConfidentialTransferReceived(
      payer.address,
      payer.address,
      ethers.zeroPadValue("0x01", 32),
      data
    );

    // Second call with same nonce should revert
    await expect(
      verifier.connect(trustedToken).onConfidentialTransferReceived(
        payer.address,
        payer.address,
        ethers.zeroPadValue("0x01", 32),
        data
      )
    ).to.be.revertedWithCustomError(verifier, "NonceAlreadyUsed");
  });

  // =========================================================================
  // FUZZ-LIKE BOUNDARY TESTS
  // =========================================================================

  describe("Fuzz-like boundary tests", function () {
    const UINT64_MAX = 18446744073709551615n;
    const UINT32_MAX = 4294967295;

    // ---- recordPayment with minPrice=0 reverts ----
    it("recordPayment with minPrice=0 reverts (ZeroMinPrice)", async function () {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      await expect(
        verifier.connect(payer).recordPayment(server.address, nonce, 0n)
      ).to.be.revertedWithCustomError(verifier, "ZeroMinPrice");
    });

    // ---- recordPayment with minPrice=1 (minimum valid) ----
    it("recordPayment with minPrice=1 succeeds", async function () {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      await expect(
        verifier.connect(payer).recordPayment(server.address, nonce, 1n)
      ).to.emit(verifier, "PaymentVerified")
        .withArgs(payer.address, server.address, nonce, 1n);
    });

    // ---- recordPayment with minPrice=uint64_max ----
    it("recordPayment with minPrice=uint64_max succeeds", async function () {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      await expect(
        verifier.connect(payer).recordPayment(server.address, nonce, UINT64_MAX)
      ).to.emit(verifier, "PaymentVerified")
        .withArgs(payer.address, server.address, nonce, UINT64_MAX);
    });

    // ---- recordBatchPayment with requestCount=1 ----
    it("recordBatchPayment with requestCount=1 succeeds", async function () {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      await expect(
        verifier.connect(payer).recordBatchPayment(server.address, nonce, 1, 1000000n)
      ).to.emit(verifier, "BatchPaymentRecorded")
        .withArgs(payer.address, server.address, nonce, 1, 1000000n);
    });

    // ---- recordBatchPayment with requestCount=uint32_max, low price (no overflow) ----
    it("recordBatchPayment with requestCount=uint32_max and pricePerRequest=1 succeeds (no overflow)", async function () {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      // 4294967295 * 1 = 4294967295 < uint64_max
      await expect(
        verifier.connect(payer).recordBatchPayment(server.address, nonce, UINT32_MAX, 1n)
      ).to.emit(verifier, "BatchPaymentRecorded")
        .withArgs(payer.address, server.address, nonce, UINT32_MAX, 1n);
    });

    // ---- recordBatchPayment with requestCount=uint32_max, high price (overflow) ----
    it("recordBatchPayment with requestCount=uint32_max and high price reverts (BatchOverflow)", async function () {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      // 4294967295 * 4294967298 = 18446744078004518910 > uint64_max (18446744073709551615)
      await expect(
        verifier.connect(payer).recordBatchPayment(server.address, nonce, UINT32_MAX, 4294967298n)
      ).to.be.revertedWithCustomError(verifier, "BatchOverflow");
    });

    // ---- recordBatchPayment with pricePerRequest=uint64_max, requestCount=1 (no overflow) ----
    it("recordBatchPayment with pricePerRequest=uint64_max and requestCount=1 succeeds", async function () {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      // 1 * uint64_max = uint64_max (fits)
      await expect(
        verifier.connect(payer).recordBatchPayment(server.address, nonce, 1, UINT64_MAX)
      ).to.emit(verifier, "BatchPaymentRecorded")
        .withArgs(payer.address, server.address, nonce, 1, UINT64_MAX);
    });

    // ---- recordBatchPayment with pricePerRequest=uint64_max, requestCount=2 (overflow) ----
    it("recordBatchPayment with pricePerRequest=uint64_max and requestCount=2 reverts (BatchOverflow)", async function () {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      await expect(
        verifier.connect(payer).recordBatchPayment(server.address, nonce, 2, UINT64_MAX)
      ).to.be.revertedWithCustomError(verifier, "BatchOverflow");
    });

    // ---- recordPayment with server=zero address ----
    it("recordPayment with server=ZeroAddress reverts", async function () {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      await expect(
        verifier.connect(payer).recordPayment(ethers.ZeroAddress, nonce, 1000000n)
      ).to.be.revertedWithCustomError(verifier, "ZeroAddress");
    });

    // ---- recordBatchPayment with server=zero address ----
    it("recordBatchPayment with server=ZeroAddress reverts", async function () {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      await expect(
        verifier.connect(payer).recordBatchPayment(ethers.ZeroAddress, nonce, 10, 100000n)
      ).to.be.revertedWithCustomError(verifier, "ZeroAddress");
    });

    // ---- Nonce exhaustion: many sequential payments ----
    it("10 sequential recordPayment calls with unique nonces all succeed", async function () {
      for (let i = 0; i < 10; i++) {
        const nonce = ethers.hexlify(ethers.randomBytes(32));
        await expect(
          verifier.connect(payer).recordPayment(server.address, nonce, BigInt(i + 1))
        ).to.not.be.reverted;
      }
    });

    // ---- Cross-function nonce collision: batch first, then single ----
    it("nonce used in recordBatchPayment blocks recordPayment with same nonce", async function () {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      await verifier.connect(payer).recordBatchPayment(server.address, nonce, 5, 100000n);
      await expect(
        verifier.connect(payer).recordPayment(server.address, nonce, 1000000n)
      ).to.be.revertedWithCustomError(verifier, "NonceAlreadyUsed");
    });

    // ---- recordBatchPayment boundary: product exactly equals uint64_max ----
    it("recordBatchPayment with product exactly uint64_max succeeds", async function () {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      // We need requestCount * pricePerRequest == uint64_max (18446744073709551615)
      // 3 * 6148914691236517205 = 18446744073709551615
      await expect(
        verifier.connect(payer).recordBatchPayment(server.address, nonce, 3, 6148914691236517205n)
      ).to.emit(verifier, "BatchPaymentRecorded")
        .withArgs(payer.address, server.address, nonce, 3, 6148914691236517205n);
    });

    // ---- recordBatchPayment boundary: product = uint64_max + 1 reverts ----
    it("recordBatchPayment with product = uint64_max + 1 reverts (BatchOverflow)", async function () {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      // 2 * 9223372036854775808 = 18446744073709551616 = uint64_max + 1
      await expect(
        verifier.connect(payer).recordBatchPayment(server.address, nonce, 2, 9223372036854775808n)
      ).to.be.revertedWithCustomError(verifier, "BatchOverflow");
    });
  });

  // =========================================================================
  // V4.3 — recordBatchPayment
  // =========================================================================

  describe("recordBatchPayment (V4.3)", function () {
    it("records batch payment with valid inputs", async function () {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      await expect(
        verifier.connect(payer).recordBatchPayment(server.address, nonce, 10, 100000n)
      ).to.not.be.reverted;

      expect(await verifier.usedNonces(nonce)).to.equal(true);
    });

    it("emits BatchPaymentRecorded with correct parameters (msg.sender as payer)", async function () {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      await expect(
        verifier.connect(payer).recordBatchPayment(server.address, nonce, 10, 100000n)
      )
        .to.emit(verifier, "BatchPaymentRecorded")
        .withArgs(payer.address, server.address, nonce, 10, 100000n);
    });

    it("reverts on duplicate nonce", async function () {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      await verifier.connect(payer).recordBatchPayment(server.address, nonce, 5, 200000n);
      await expect(
        verifier.connect(payer).recordBatchPayment(server.address, nonce, 5, 200000n)
      ).to.be.revertedWithCustomError(verifier, "NonceAlreadyUsed");
    });

    it("reverts on zero request count", async function () {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      await expect(
        verifier.connect(payer).recordBatchPayment(server.address, nonce, 0, 100000n)
      ).to.be.revertedWithCustomError(verifier, "ZeroRequestCount");
    });

    it("nonce is shared between recordPayment and recordBatchPayment", async function () {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      await verifier.connect(payer).recordPayment(server.address, nonce, 1000000n);
      await expect(
        verifier.connect(payer).recordBatchPayment(server.address, nonce, 10, 100000n)
      ).to.be.revertedWithCustomError(verifier, "NonceAlreadyUsed");
    });

    it("anyone can call recordBatchPayment (permissionless)", async function () {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      await expect(
        verifier.connect(other).recordBatchPayment(server.address, nonce, 3, 500000n)
      ).to.not.be.reverted;
    });

    it("different batch nonces work independently", async function () {
      const nonce1 = ethers.hexlify(ethers.randomBytes(32));
      const nonce2 = ethers.hexlify(ethers.randomBytes(32));

      await verifier.connect(payer).recordBatchPayment(server.address, nonce1, 10, 100000n);
      await verifier.connect(payer).recordBatchPayment(server.address, nonce2, 20, 50000n);

      expect(await verifier.usedNonces(nonce1)).to.equal(true);
      expect(await verifier.usedNonces(nonce2)).to.equal(true);
    });

    it("works with large request count and price", async function () {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      // 1000 requests at 10 USDC each
      await expect(
        verifier.connect(payer).recordBatchPayment(server.address, nonce, 1000, 10000000n)
      )
        .to.emit(verifier, "BatchPaymentRecorded")
        .withArgs(payer.address, server.address, nonce, 1000, 10000000n);
    });

    it("works with requestCount = 1", async function () {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      await expect(
        verifier.connect(payer).recordBatchPayment(server.address, nonce, 1, 100000n)
      ).to.not.be.reverted;
    });

    it("recordBatchPayment reverts on zero pricePerRequest", async function () {
      await expect(
        verifier.connect(payer).recordBatchPayment(server.address, ethers.hexlify(ethers.randomBytes(32)), 10, 0)
      ).to.be.revertedWithCustomError(verifier, "ZeroMinPrice");
    });

    it("recordBatchPayment reverts on overflow (requestCount * pricePerRequest > uint64 max)", async function () {
      // uint64 max = 18446744073709551615 (~1.8e19)
      // requestCount = 4294967295 (uint32 max), pricePerRequest = 2^33 = 8589934592
      // Product = 4294967295 * 8589934592 = 36893488151674060800 (~3.7e19) > uint64 max
      await expect(
        verifier.connect(payer).recordBatchPayment(
          server.address,
          ethers.hexlify(ethers.randomBytes(32)),
          4294967295, // uint32 max
          8589934592n // 2^33 — ensures product > uint64 max
        )
      ).to.be.revertedWithCustomError(verifier, "BatchOverflow");
    });
  });
});
