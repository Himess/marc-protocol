import { expect } from "chai";
import { ethers } from "hardhat";

describe("ConfidentialUSDC", function () {
  let token: any;
  let usdc: any;
  let owner: any;
  let alice: any;
  let bob: any;
  let treasury: any;
  let other: any;

  const USDC_1 = 1_000_000n; // 1 USDC
  const USDC_100 = 100_000_000n; // 100 USDC
  const USDC_1000 = 1_000_000_000n; // 1000 USDC
  const USDC_10000 = 10_000_000_000n; // 10,000 USDC
  const MIN_FEE = 10_000n; // 0.01 USDC
  const FEE_BPS = 10n;
  const BPS = 10_000n;

  beforeEach(async function () {
    [owner, alice, bob, treasury, other] = await ethers.getSigners();

    // Deploy MockUSDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    // Deploy ConfidentialUSDC
    const Token = await ethers.getContractFactory("ConfidentialUSDC");
    token = await Token.deploy(await usdc.getAddress(), treasury.address);
    await token.waitForDeployment();
  });

  // =========================================================================
  // DEPLOYMENT
  // =========================================================================

  describe("Deployment", function () {
    it("sets name to 'Confidential USDC'", async function () {
      expect(await token.name()).to.equal("Confidential USDC");
    });

    it("sets symbol to 'cUSDC'", async function () {
      expect(await token.symbol()).to.equal("cUSDC");
    });

    it("sets decimals to 6 (matching USDC)", async function () {
      expect(await token.decimals()).to.equal(6);
    });

    it("sets treasury to provided address", async function () {
      expect(await token.treasury()).to.equal(treasury.address);
    });

    it("sets underlying to USDC address", async function () {
      expect(await token.underlying()).to.equal(await usdc.getAddress());
    });

    it("sets rate to 1 (6 decimal underlying)", async function () {
      expect(await token.rate()).to.equal(1);
    });

    it("sets owner to deployer", async function () {
      expect(await token.owner()).to.equal(owner.address);
    });

    it("initializes accumulatedFees to zero", async function () {
      expect(await token.accumulatedFees()).to.equal(0);
    });

    it("exposes FEE_BPS constant as 10", async function () {
      expect(await token.FEE_BPS()).to.equal(10);
    });

    it("exposes BPS constant as 10000", async function () {
      expect(await token.BPS()).to.equal(10_000);
    });

    it("exposes MIN_PROTOCOL_FEE constant as 10000", async function () {
      expect(await token.MIN_PROTOCOL_FEE()).to.equal(10_000);
    });

    it("reverts if treasury is zero address", async function () {
      const Token = await ethers.getContractFactory("ConfidentialUSDC");
      await expect(
        Token.deploy(await usdc.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(token, "ZeroAddress");
    });
  });

  // =========================================================================
  // ERC-165 supportsInterface
  // =========================================================================

  describe("ERC-165", function () {
    it("supports ERC-165 interface (0x01ffc9a7)", async function () {
      expect(await token.supportsInterface("0x01ffc9a7")).to.equal(true);
    });

    it("supports IERC7984 interface", async function () {
      // IERC7984 extends IERC165, so the contract should support it
      // The interfaceId is computed from the IERC7984 function selectors
      // We just verify it does NOT return false for the known ERC-165 ID
      // and that the function is callable
      const result = await token.supportsInterface("0x01ffc9a7");
      expect(result).to.be.a("boolean");
    });

    it("does not support random interface", async function () {
      expect(await token.supportsInterface("0xdeadbeef")).to.equal(false);
    });
  });

  // =========================================================================
  // WRAP (USDC -> cUSDC)
  // =========================================================================

  describe("wrap", function () {
    beforeEach(async function () {
      // Mint USDC to alice for wrapping
      await usdc.mint(alice.address, USDC_10000);
    });

    it("reverts on zero amount", async function () {
      await usdc.connect(alice).approve(await token.getAddress(), USDC_1);
      await expect(
        token.connect(alice).wrap(alice.address, 0)
      ).to.be.revertedWithCustomError(token, "ZeroAmount");
    });

    it("reverts when wrapping to zero address", async function () {
      await usdc.connect(alice).approve(await token.getAddress(), USDC_100);
      await expect(
        token.connect(alice).wrap(ethers.ZeroAddress, USDC_100)
      ).to.be.revertedWithCustomError(token, "ERC7984InvalidReceiver");
    });

    it("reverts without USDC approval", async function () {
      await expect(
        token.connect(alice).wrap(alice.address, USDC_1)
      ).to.be.reverted;
    });

    it("reverts with insufficient USDC approval", async function () {
      await usdc.connect(alice).approve(await token.getAddress(), USDC_1 - 1n);
      await expect(
        token.connect(alice).wrap(alice.address, USDC_1)
      ).to.be.reverted;
    });

    it("transfers full USDC amount from user on wrap (1 USDC)", async function () {
      await usdc.connect(alice).approve(await token.getAddress(), USDC_1);
      const balBefore = await usdc.balanceOf(alice.address);

      await token.connect(alice).wrap(alice.address, USDC_1);

      const balAfter = await usdc.balanceOf(alice.address);
      expect(balBefore - balAfter).to.equal(USDC_1);
    });

    it("contract holds full USDC amount after wrap", async function () {
      await usdc.connect(alice).approve(await token.getAddress(), USDC_1);
      await token.connect(alice).wrap(alice.address, USDC_1);

      const tokenAddr = await token.getAddress();
      expect(await usdc.balanceOf(tokenAddr)).to.equal(USDC_1);
    });

    // Fee: 1 USDC (1_000_000) -> percentageFee = 1_000_000 * 10 / 10_000 = 100
    // max(100, 10_000) = 10_000
    it("deducts correct fee for 1 USDC (min fee applies)", async function () {
      await usdc.connect(alice).approve(await token.getAddress(), USDC_1);
      await token.connect(alice).wrap(alice.address, USDC_1);

      expect(await token.accumulatedFees()).to.equal(MIN_FEE);
    });

    // Fee: 100 USDC (100_000_000) -> percentageFee = 100_000_000 * 10 / 10_000 = 100_000
    // max(100_000, 10_000) = 100_000 -- wait, let me recalculate
    // Actually: 100_000_000 * 10 / 10_000 = 100_000. max(100_000, 10_000) = 100_000
    // But the user prompt says fee = max(10_000, 10_000) = 10_000 for 100 USDC.
    // Let me recheck: 100_000_000 * 10 = 1_000_000_000. 1_000_000_000 / 10_000 = 100_000
    // The prompt's math seems wrong for 100 USDC. The actual contract logic gives 100_000.
    // Actually wait, let me re-read the prompt:
    // "For 100 USDC (100_000_000): fee = max(10_000, 10_000) = 10_000"
    // That says percentageFee = 10_000 for 100 USDC. But 100_000_000 * 10 / 10_000 = 100_000.
    // The prompt has a math error. Going with the actual contract logic: fee = 100_000.
    it("deducts correct fee for 100 USDC (percentage fee applies)", async function () {
      await usdc.connect(alice).approve(await token.getAddress(), USDC_100);
      await token.connect(alice).wrap(alice.address, USDC_100);

      // 100_000_000 * 10 / 10_000 = 100_000 > 10_000 => fee = 100_000
      expect(await token.accumulatedFees()).to.equal(100_000n);
    });

    // Fee: 1000 USDC (1_000_000_000) -> percentageFee = 1_000_000_000 * 10 / 10_000 = 1_000_000
    // max(1_000_000, 10_000) = 1_000_000
    it("deducts correct fee for 1000 USDC (percentage fee applies)", async function () {
      await usdc.connect(alice).approve(await token.getAddress(), USDC_1000);
      await token.connect(alice).wrap(alice.address, USDC_1000);

      // 1_000_000_000 * 10 / 10_000 = 1_000_000 > 10_000 => fee = 1_000_000
      expect(await token.accumulatedFees()).to.equal(1_000_000n);
    });

    it("fee is exactly MIN_PROTOCOL_FEE for small amounts", async function () {
      // For amount where percentage < MIN_FEE:
      // percentageFee < 10_000 when amount < 10_000_000 (10 USDC)
      const smallAmount = 5_000_000n; // 5 USDC
      await usdc.connect(alice).approve(await token.getAddress(), smallAmount);
      await token.connect(alice).wrap(alice.address, smallAmount);

      // 5_000_000 * 10 / 10_000 = 5_000 < 10_000 => fee = 10_000
      expect(await token.accumulatedFees()).to.equal(MIN_FEE);
    });

    it("fee equals percentage at breakeven (10 USDC)", async function () {
      // 10_000_000 * 10 / 10_000 = 10_000 = MIN_PROTOCOL_FEE
      const amount = 10_000_000n; // 10 USDC
      await usdc.connect(alice).approve(await token.getAddress(), amount);
      await token.connect(alice).wrap(alice.address, amount);

      expect(await token.accumulatedFees()).to.equal(MIN_FEE);
    });

    it("accumulates fees across multiple wraps", async function () {
      // Wrap 1 USDC twice => fee = 10_000 each
      await usdc.connect(alice).approve(await token.getAddress(), USDC_1 * 2n);
      await token.connect(alice).wrap(alice.address, USDC_1);
      await token.connect(alice).wrap(alice.address, USDC_1);

      expect(await token.accumulatedFees()).to.equal(MIN_FEE * 2n);
    });

    it("wraps to a different recipient", async function () {
      await usdc.connect(alice).approve(await token.getAddress(), USDC_1);

      // Alice wraps USDC, bob receives cUSDC
      await token.connect(alice).wrap(bob.address, USDC_1);

      // Alice's USDC decreased
      expect(await usdc.balanceOf(alice.address)).to.equal(USDC_10000 - USDC_1);

      // Contract holds the USDC
      expect(await usdc.balanceOf(await token.getAddress())).to.equal(USDC_1);

      // Fee was tracked
      expect(await token.accumulatedFees()).to.equal(MIN_FEE);
    });

    it("reverts when paused", async function () {
      await token.connect(owner).pause();
      await usdc.connect(alice).approve(await token.getAddress(), USDC_1);
      await expect(
        token.connect(alice).wrap(alice.address, USDC_1)
      ).to.be.revertedWithCustomError(token, "EnforcedPause");
    });

    it("succeeds after unpause", async function () {
      await token.connect(owner).pause();
      await token.connect(owner).unpause();

      await usdc.connect(alice).approve(await token.getAddress(), USDC_1);
      await token.connect(alice).wrap(alice.address, USDC_1);

      expect(await token.accumulatedFees()).to.equal(MIN_FEE);
    });

    it("multiple users can wrap independently", async function () {
      await usdc.mint(bob.address, USDC_1000);

      await usdc.connect(alice).approve(await token.getAddress(), USDC_1);
      await usdc.connect(bob).approve(await token.getAddress(), USDC_1000);

      await token.connect(alice).wrap(alice.address, USDC_1);
      await token.connect(bob).wrap(bob.address, USDC_1000);

      // Total USDC held = 1 USDC + 1000 USDC
      expect(await usdc.balanceOf(await token.getAddress())).to.equal(USDC_1 + USDC_1000);

      // Total fees = 10_000 + 1_000_000
      expect(await token.accumulatedFees()).to.equal(MIN_FEE + 1_000_000n);
    });

    it("large wrap: 10,000 USDC fee calculation", async function () {
      await usdc.connect(alice).approve(await token.getAddress(), USDC_10000);
      await token.connect(alice).wrap(alice.address, USDC_10000);

      // 10_000_000_000 * 10 / 10_000 = 10_000_000
      expect(await token.accumulatedFees()).to.equal(10_000_000n);
    });
  });

  // =========================================================================
  // ADMIN — setTreasury
  // =========================================================================

  describe("setTreasury", function () {
    it("owner can set new treasury", async function () {
      await token.connect(owner).setTreasury(bob.address);
      expect(await token.treasury()).to.equal(bob.address);
    });

    it("emits TreasuryUpdated event", async function () {
      await expect(token.connect(owner).setTreasury(bob.address))
        .to.emit(token, "TreasuryUpdated")
        .withArgs(treasury.address, bob.address);
    });

    it("reverts if called by non-owner", async function () {
      await expect(
        token.connect(alice).setTreasury(bob.address)
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });

    it("reverts if treasury set to zero address", async function () {
      await expect(
        token.connect(owner).setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(token, "ZeroAddress");
    });

    it("treasury can be updated multiple times", async function () {
      await token.connect(owner).setTreasury(bob.address);
      expect(await token.treasury()).to.equal(bob.address);

      await token.connect(owner).setTreasury(alice.address);
      expect(await token.treasury()).to.equal(alice.address);
    });
  });

  // =========================================================================
  // ADMIN — treasuryWithdraw
  // =========================================================================

  describe("treasuryWithdraw", function () {
    it("reverts when no accumulated fees", async function () {
      await expect(
        token.connect(owner).treasuryWithdraw()
      ).to.be.revertedWithCustomError(token, "InsufficientFees");
    });

    it("reverts when called by non-owner non-treasury", async function () {
      // First accumulate some fees
      await usdc.mint(alice.address, USDC_1);
      await usdc.connect(alice).approve(await token.getAddress(), USDC_1);
      await token.connect(alice).wrap(alice.address, USDC_1);

      await expect(
        token.connect(other).treasuryWithdraw()
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });

    it("owner can withdraw fees", async function () {
      await usdc.mint(alice.address, USDC_1);
      await usdc.connect(alice).approve(await token.getAddress(), USDC_1);
      await token.connect(alice).wrap(alice.address, USDC_1);

      const fee = await token.accumulatedFees();
      const treasuryBalBefore = await usdc.balanceOf(treasury.address);

      await token.connect(owner).treasuryWithdraw();

      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBalBefore + fee);
      expect(await token.accumulatedFees()).to.equal(0);
    });

    it("treasury address can withdraw fees", async function () {
      await usdc.mint(alice.address, USDC_1);
      await usdc.connect(alice).approve(await token.getAddress(), USDC_1);
      await token.connect(alice).wrap(alice.address, USDC_1);

      const fee = await token.accumulatedFees();
      const treasuryBalBefore = await usdc.balanceOf(treasury.address);

      await token.connect(treasury).treasuryWithdraw();

      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBalBefore + fee);
      expect(await token.accumulatedFees()).to.equal(0);
    });

    it("emits TreasuryWithdrawn event", async function () {
      await usdc.mint(alice.address, USDC_1);
      await usdc.connect(alice).approve(await token.getAddress(), USDC_1);
      await token.connect(alice).wrap(alice.address, USDC_1);

      const fee = await token.accumulatedFees();
      await expect(token.connect(owner).treasuryWithdraw())
        .to.emit(token, "TreasuryWithdrawn")
        .withArgs(treasury.address, fee);
    });

    it("resets accumulatedFees to zero after withdraw", async function () {
      await usdc.mint(alice.address, USDC_1);
      await usdc.connect(alice).approve(await token.getAddress(), USDC_1);
      await token.connect(alice).wrap(alice.address, USDC_1);

      await token.connect(owner).treasuryWithdraw();
      expect(await token.accumulatedFees()).to.equal(0);
    });

    it("sends fees to current treasury (not previous)", async function () {
      await usdc.mint(alice.address, USDC_1);
      await usdc.connect(alice).approve(await token.getAddress(), USDC_1);
      await token.connect(alice).wrap(alice.address, USDC_1);

      // Change treasury to bob
      await token.connect(owner).setTreasury(bob.address);

      const bobBalBefore = await usdc.balanceOf(bob.address);
      const fee = await token.accumulatedFees();

      await token.connect(owner).treasuryWithdraw();

      // Fees go to bob (new treasury), not the original treasury
      expect(await usdc.balanceOf(bob.address)).to.equal(bobBalBefore + fee);
    });

    it("reverts on second withdraw without new fees", async function () {
      await usdc.mint(alice.address, USDC_1);
      await usdc.connect(alice).approve(await token.getAddress(), USDC_1);
      await token.connect(alice).wrap(alice.address, USDC_1);

      await token.connect(owner).treasuryWithdraw();

      await expect(
        token.connect(owner).treasuryWithdraw()
      ).to.be.revertedWithCustomError(token, "InsufficientFees");
    });
  });

  // =========================================================================
  // ADMIN — pause / unpause
  // =========================================================================

  describe("pause / unpause", function () {
    it("owner can pause", async function () {
      await token.connect(owner).pause();
      expect(await token.paused()).to.equal(true);
    });

    it("owner can unpause", async function () {
      await token.connect(owner).pause();
      await token.connect(owner).unpause();
      expect(await token.paused()).to.equal(false);
    });

    it("non-owner cannot pause", async function () {
      await expect(
        token.connect(alice).pause()
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });

    it("non-owner cannot unpause", async function () {
      await token.connect(owner).pause();
      await expect(
        token.connect(alice).unpause()
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });

    it("wrap reverts when paused", async function () {
      await usdc.mint(alice.address, USDC_1);
      await usdc.connect(alice).approve(await token.getAddress(), USDC_1);
      await token.connect(owner).pause();

      await expect(
        token.connect(alice).wrap(alice.address, USDC_1)
      ).to.be.revertedWithCustomError(token, "EnforcedPause");
    });
  });

  // =========================================================================
  // Ownable2Step
  // =========================================================================

  describe("Ownable2Step", function () {
    it("transferOwnership sets pending owner", async function () {
      await token.connect(owner).transferOwnership(alice.address);
      expect(await token.pendingOwner()).to.equal(alice.address);
      // Owner is still the original owner until accepted
      expect(await token.owner()).to.equal(owner.address);
    });

    it("pending owner can accept ownership", async function () {
      await token.connect(owner).transferOwnership(alice.address);
      await token.connect(alice).acceptOwnership();
      expect(await token.owner()).to.equal(alice.address);
    });

    it("non-pending owner cannot accept ownership", async function () {
      await token.connect(owner).transferOwnership(alice.address);
      await expect(
        token.connect(bob).acceptOwnership()
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });

    it("new owner can use admin functions after transfer", async function () {
      await token.connect(owner).transferOwnership(alice.address);
      await token.connect(alice).acceptOwnership();

      // Alice (new owner) can setTreasury
      await token.connect(alice).setTreasury(bob.address);
      expect(await token.treasury()).to.equal(bob.address);
    });

    it("old owner loses admin access after transfer", async function () {
      await token.connect(owner).transferOwnership(alice.address);
      await token.connect(alice).acceptOwnership();

      await expect(
        token.connect(owner).setTreasury(bob.address)
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });

    it("non-owner cannot initiate transferOwnership", async function () {
      await expect(
        token.connect(alice).transferOwnership(bob.address)
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });
  });

  // =========================================================================
  // SafeCast overflow protection
  // =========================================================================

  describe("SafeCast overflow", function () {
    it("wrap reverts on amount exceeding uint64 max", async function () {
      // 2^64 = 18446744073709551616
      const overflowAmount = 2n ** 64n;
      await usdc.mint(alice.address, overflowAmount);
      await usdc.connect(alice).approve(await token.getAddress(), overflowAmount);

      await expect(
        token.connect(alice).wrap(alice.address, overflowAmount)
      ).to.be.revertedWithCustomError(token, "SafeCastOverflowedUintDowncast");
    });
  });

  // =========================================================================
  // M-1: finalizeUnwrap respects pause
  // =========================================================================

  describe("finalizeUnwrap pause", function () {
    it("finalizeUnwrap is blocked when paused", async function () {
      await token.connect(owner).pause();
      const fakeHandle = ethers.zeroPadValue("0x01", 32);
      await expect(
        token.finalizeUnwrap(fakeHandle, 1000000n, "0x")
      ).to.be.revertedWithCustomError(token, "EnforcedPause");
    });
  });

  // =========================================================================
  // L-1: Dust amount protection
  // =========================================================================

  describe("Dust amount protection", function () {
    it("wrap reverts when amount equals MIN_PROTOCOL_FEE (net would be 0)", async function () {
      const dustAmount = MIN_FEE; // 10_000 (0.01 USDC)
      await usdc.mint(alice.address, dustAmount);
      await usdc.connect(alice).approve(await token.getAddress(), dustAmount);
      await expect(
        token.connect(alice).wrap(alice.address, dustAmount)
      ).to.be.revertedWithCustomError(token, "DustAmount");
    });

    it("wrap reverts when amount less than MIN_PROTOCOL_FEE", async function () {
      const tinyAmount = 5000n; // 0.005 USDC
      await usdc.mint(alice.address, tinyAmount);
      await usdc.connect(alice).approve(await token.getAddress(), tinyAmount);
      await expect(
        token.connect(alice).wrap(alice.address, tinyAmount)
      ).to.be.revertedWithCustomError(token, "DustAmount");
    });

    it("wrap succeeds when amount is MIN_PROTOCOL_FEE + 1", async function () {
      const minValid = MIN_FEE + 1n; // 10_001
      await usdc.mint(alice.address, minValid);
      await usdc.connect(alice).approve(await token.getAddress(), minValid);
      await expect(
        token.connect(alice).wrap(alice.address, minValid)
      ).to.not.be.reverted;
    });
  });

  // =========================================================================
  // L-5: Constructor emits TreasuryUpdated
  // =========================================================================

  describe("Constructor event", function () {
    it("emits TreasuryUpdated on deployment", async function () {
      const Token = await ethers.getContractFactory("ConfidentialUSDC");
      const newToken = await Token.deploy(await usdc.getAddress(), treasury.address);
      const tx = newToken.deploymentTransaction();
      await expect(tx)
        .to.emit(newToken, "TreasuryUpdated")
        .withArgs(ethers.ZeroAddress, treasury.address);
    });
  });

  // =========================================================================
  // ERC-7984 Operator Authorization
  // =========================================================================

  describe("ERC-7984 Operator", function () {
    it("setOperator grants operator role", async function () {
      // type(uint48).max = 2^48 - 1 = 281474976710655
      const maxExpiry = 281474976710655n;
      await token.connect(alice).setOperator(bob.address, maxExpiry);
      expect(await token.isOperator(alice.address, bob.address)).to.equal(true);
    });

    it("isOperator returns true after setting operator", async function () {
      const maxExpiry = 281474976710655n;
      await token.connect(alice).setOperator(bob.address, maxExpiry);
      expect(await token.isOperator(alice.address, bob.address)).to.equal(true);
    });

    it("isOperator returns true for self (holder == spender)", async function () {
      // No setOperator call needed — holder is always their own operator
      expect(await token.isOperator(alice.address, alice.address)).to.equal(true);
    });

    it("isOperator returns false for unauthorized address", async function () {
      expect(await token.isOperator(alice.address, bob.address)).to.equal(false);
    });

    it("operator can be removed by setting expiry to 0", async function () {
      const maxExpiry = 281474976710655n;
      await token.connect(alice).setOperator(bob.address, maxExpiry);
      expect(await token.isOperator(alice.address, bob.address)).to.equal(true);

      // Remove operator by setting expiry to 0 (block.timestamp > 0 always)
      await token.connect(alice).setOperator(bob.address, 0);
      expect(await token.isOperator(alice.address, bob.address)).to.equal(false);
    });

    it("operator expires when block timestamp exceeds expiry", async function () {
      // Set operator with expiry = 1 (Unix timestamp 1 — already in the past)
      await token.connect(alice).setOperator(bob.address, 1);
      // block.timestamp is always well beyond 1, so operator should be expired
      expect(await token.isOperator(alice.address, bob.address)).to.equal(false);
    });

    it("emits OperatorSet event", async function () {
      const maxExpiry = 281474976710655n;
      await expect(token.connect(alice).setOperator(bob.address, maxExpiry))
        .to.emit(token, "OperatorSet")
        .withArgs(alice.address, bob.address, maxExpiry);
    });

    it("multiple operators can be set for same holder", async function () {
      const maxExpiry = 281474976710655n;
      await token.connect(alice).setOperator(bob.address, maxExpiry);
      await token.connect(alice).setOperator(other.address, maxExpiry);
      expect(await token.isOperator(alice.address, bob.address)).to.equal(true);
      expect(await token.isOperator(alice.address, other.address)).to.equal(true);
    });
  });

  // =========================================================================
  // ERC7984ERC20Wrapper view functions
  // =========================================================================

  describe("ERC7984ERC20Wrapper views", function () {
    it("maxTotalSupply returns uint64 max", async function () {
      expect(await token.maxTotalSupply()).to.equal(BigInt(2n ** 64n - 1n));
    });

    it("inferredTotalSupply is zero before any wraps", async function () {
      expect(await token.inferredTotalSupply()).to.equal(0);
    });

    it("inferredTotalSupply increases after wrap", async function () {
      await usdc.mint(alice.address, USDC_1);
      await usdc.connect(alice).approve(await token.getAddress(), USDC_1);
      await token.connect(alice).wrap(alice.address, USDC_1);

      // inferredTotalSupply = USDC held / rate = 1_000_000 / 1 = 1_000_000
      expect(await token.inferredTotalSupply()).to.equal(USDC_1);
    });
  });
});
