import { expect } from "chai";
import { ethers } from "hardhat";
import { fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("ConfidentialPaymentPoolUpgradeable — Proxy", function () {
  let pool: any;
  let usdc: any;
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let implAddress: string;
  let proxyAddress: string;

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    deployer = signers[0];
    alice = signers[1];
    treasury = signers[2];

    // Deploy MockUSDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    // Deploy implementation
    const PoolImpl = await ethers.getContractFactory("ConfidentialPaymentPoolUpgradeable");
    const impl = await PoolImpl.deploy();
    await impl.waitForDeployment();
    implAddress = await impl.getAddress();

    // Encode initialize calldata
    const initData = PoolImpl.interface.encodeFunctionData("initialize", [
      await usdc.getAddress(),
      treasury.address,
    ]);

    // Deploy ERC1967Proxy
    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await ERC1967Proxy.deploy(implAddress, initData);
    await proxy.waitForDeployment();
    proxyAddress = await proxy.getAddress();

    // Attach implementation ABI to proxy address
    pool = PoolImpl.attach(proxyAddress);

    // Mint USDC to alice
    await usdc.mint(alice.address, 100_000_000n); // 100 USDC
    await usdc.connect(alice).approve(proxyAddress, 100_000_000n);
  });

  it("should initialize state correctly via proxy", async function () {
    expect(await pool.owner()).to.equal(deployer.address);
    expect(await pool.treasury()).to.equal(treasury.address);
    expect(await pool.usdc()).to.equal(await usdc.getAddress());
    expect(await pool.paused()).to.equal(false);
  });

  it("should reject double initialization", async function () {
    let reverted = false;
    try {
      await pool.initialize(await usdc.getAddress(), treasury.address);
    } catch {
      reverted = true;
    }
    expect(reverted).to.equal(true);
  });

  it("should deposit and credit encrypted balance through proxy", async function () {
    await pool.connect(alice).deposit(10_000_000); // 10 USDC

    // Net = 10_000_000 - max(10_000, 10_000) = 9_990_000
    const encBalance = await pool.balanceOf(alice.address);
    const balance = await fhevm.userDecryptEuint(FhevmType.euint64, encBalance, proxyAddress, alice);
    expect(balance).to.equal(9_990_000n);
  });

  it("should credit fee to treasury through proxy", async function () {
    await pool.connect(alice).deposit(10_000_000);

    const encTreasuryBal = await pool.balanceOf(treasury.address);
    const treasuryBal = await fhevm.userDecryptEuint(FhevmType.euint64, encTreasuryBal, proxyAddress, treasury);
    expect(treasuryBal).to.equal(10_000n);
  });

  it("should emit Deposited event through proxy", async function () {
    const tx = await pool.connect(alice).deposit(5_000_000);
    const receipt = await tx.wait();

    const event = receipt.logs.find((log: any) => {
      try {
        const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
        return parsed?.name === "Deposited";
      } catch {
        return false;
      }
    });
    expect(event).to.not.be.undefined;
  });

  it("should upgrade to V3 mock and preserve state", async function () {
    // Deposit first
    await pool.connect(alice).deposit(10_000_000);

    // Verify pre-upgrade state
    const encBefore = await pool.balanceOf(alice.address);
    const balBefore = await fhevm.userDecryptEuint(FhevmType.euint64, encBefore, proxyAddress, alice);
    expect(balBefore).to.equal(9_990_000n);

    // Deploy V3 implementation (same contract, simulating upgrade)
    const PoolV3 = await ethers.getContractFactory("ConfidentialPaymentPoolUpgradeable");
    const v3Impl = await PoolV3.deploy();
    await v3Impl.waitForDeployment();

    // Upgrade via UUPS
    await pool.connect(deployer).upgradeToAndCall(await v3Impl.getAddress(), "0x");

    // Verify state survives upgrade
    const encAfter = await pool.balanceOf(alice.address);
    const balAfter = await fhevm.userDecryptEuint(FhevmType.euint64, encAfter, proxyAddress, alice);
    expect(balAfter).to.equal(9_990_000n);

    // Verify pool still works after upgrade
    expect(await pool.owner()).to.equal(deployer.address);
    expect(await pool.treasury()).to.equal(treasury.address);
    expect(await pool.isInitialized(alice.address)).to.equal(true);
  });

  it("should reject upgrade from non-owner", async function () {
    const PoolV3 = await ethers.getContractFactory("ConfidentialPaymentPoolUpgradeable");
    const v3Impl = await PoolV3.deploy();
    await v3Impl.waitForDeployment();

    let reverted = false;
    try {
      await pool.connect(alice).upgradeToAndCall(await v3Impl.getAddress(), "0x");
    } catch {
      reverted = true;
    }
    expect(reverted).to.equal(true);
  });

  it("should revert on zero deposit through proxy", async function () {
    await expect(pool.connect(alice).deposit(0)).to.be.revertedWithCustomError(pool, "ZeroAmount");
  });

  it("should mark user as initialized after deposit through proxy", async function () {
    expect(await pool.isInitialized(alice.address)).to.equal(false);
    await pool.connect(alice).deposit(1_000_000);
    expect(await pool.isInitialized(alice.address)).to.equal(true);
  });

  it("should support pause/unpause through proxy", async function () {
    await pool.connect(deployer).pause();
    expect(await pool.paused()).to.equal(true);

    let reverted = false;
    try {
      await pool.connect(alice).deposit(1_000_000);
    } catch {
      reverted = true;
    }
    expect(reverted).to.equal(true);

    await pool.connect(deployer).unpause();
    expect(await pool.paused()).to.equal(false);
    await pool.connect(alice).deposit(1_000_000); // should work
  });
});
