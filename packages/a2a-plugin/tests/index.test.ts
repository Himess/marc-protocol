import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mock ethers BEFORE importing the skill
// ============================================================================

const mockApprove = vi.fn();
const mockBalanceOf = vi.fn().mockResolvedValue(5_000_000n);
const mockWrap = vi.fn();
const mockConfidentialTransfer = vi.fn();
const mockUnwrap = vi.fn();
const mockConfidentialBalanceOf = vi.fn();
const mockRecordPayment = vi.fn();
const mockGetAddress = vi.fn().mockResolvedValue("0x1234567890abcdef1234567890abcdef12345678");

vi.mock("ethers", () => ({
  Contract: vi.fn().mockImplementation((_addr: string, abi: any) => {
    const abiStr = JSON.stringify(abi);
    if (abiStr.includes("wrap")) {
      // Token contract (cUSDC / ERC-7984)
      return {
        wrap: mockWrap,
        confidentialTransfer: mockConfidentialTransfer,
        unwrap: mockUnwrap,
        confidentialBalanceOf: mockConfidentialBalanceOf,
      };
    }
    if (abiStr.includes("recordPayment")) {
      // Verifier contract (nonce registry)
      return {
        recordPayment: mockRecordPayment,
      };
    }
    // USDC contract
    return {
      approve: mockApprove,
      balanceOf: mockBalanceOf,
    };
  }),
  ethers: {
    hexlify: vi.fn().mockReturnValue("0x" + "ab".repeat(32)),
    randomBytes: vi.fn().mockReturnValue(new Uint8Array(32)),
  },
}));

// ============================================================================
// Import the skill after mocks
// ============================================================================

import {
  MarcA2ASkill,
  MarcA2AError,
  MARC_SEPOLIA_ADDRESSES,
  TOKEN_ABI,
  VERIFIER_ABI,
  USDC_ABI,
  handleWrap,
  handleUnwrap,
  handleTransfer,
  handleBalance,
  handlePay,
} from "../src/index.js";
import type { A2AContext, A2AResult, Signer, FhevmInstance } from "../src/index.js";

// ============================================================================
// Helpers
// ============================================================================

const VALID_ADDRESS_A = "0x1234567890abcdef1234567890abcdef12345678";
const VALID_ADDRESS_B = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const VALID_TOKEN = MARC_SEPOLIA_ADDRESSES.tokenAddress;
const VALID_VERIFIER = MARC_SEPOLIA_ADDRESSES.verifierAddress;
const VALID_USDC = MARC_SEPOLIA_ADDRESSES.usdcAddress;

function createMockSigner(): Signer {
  return {
    getAddress: mockGetAddress,
    signMessage: vi.fn().mockResolvedValue("0xmocksignature"),
  };
}

function createMockFhevmInstance(): FhevmInstance {
  return {
    createEncryptedInput: vi.fn().mockReturnValue({
      add64: vi.fn(),
      addAddress: vi.fn(),
      encrypt: vi.fn().mockResolvedValue({
        handles: ["0x" + "ff".repeat(32)],
        inputProof: "0x" + "ee".repeat(64),
      }),
    }),
  };
}

function createContext(opts?: { noFhevm?: boolean }): A2AContext {
  return {
    signer: createMockSigner(),
    fhevmInstance: opts?.noFhevm ? undefined : createMockFhevmInstance(),
  };
}

function mockTxReceipt(hash: string, blockNumber = 12345) {
  return {
    hash,
    blockNumber,
    status: 1,
    wait: vi.fn().mockResolvedValue({ hash, blockNumber, status: 1 }),
  };
}

// ============================================================================
// MarcA2ASkill — structure tests
// ============================================================================

describe("MarcA2ASkill structure", () => {
  it("creates skill with correct id, name, description", () => {
    const skill = new MarcA2ASkill();
    expect(skill.id).toBe("marc-protocol-fhe-payments");
    expect(skill.name).toBe("MARC Protocol FHE Payments");
    expect(skill.description).toContain("FHE-encrypted USDC");
  });

  it("getSkillDescriptor returns valid A2ASkill", () => {
    const skill = new MarcA2ASkill();
    const descriptor = skill.getSkillDescriptor();
    expect(descriptor.id).toBe("marc-protocol-fhe-payments");
    expect(descriptor.name).toBe("MARC Protocol FHE Payments");
    expect(descriptor.actions).toHaveLength(5);
  });

  it("has all five expected actions", () => {
    const skill = new MarcA2ASkill();
    const names = skill.listActions();
    expect(names).toEqual(["marc_wrap", "marc_unwrap", "marc_transfer", "marc_balance", "marc_pay"]);
  });

  it("each action has name, description, inputSchema, handler", () => {
    const skill = new MarcA2ASkill();
    const descriptor = skill.getSkillDescriptor();
    for (const action of descriptor.actions) {
      expect(action.name).toBeTruthy();
      expect(action.description).toBeTruthy();
      expect(action.inputSchema).toBeDefined();
      expect(typeof action.handler).toBe("function");
    }
  });

  it("getAction returns correct action by name", () => {
    const skill = new MarcA2ASkill();
    const wrap = skill.getAction("marc_wrap");
    expect(wrap).toBeDefined();
    expect(wrap!.name).toBe("marc_wrap");
  });

  it("getAction returns undefined for unknown name", () => {
    const skill = new MarcA2ASkill();
    expect(skill.getAction("nonexistent")).toBeUndefined();
  });

  it("executeAction returns error for unknown action", async () => {
    const skill = new MarcA2ASkill();
    const result = await skill.executeAction("bad_action", {}, createContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown action");
    expect(result.error).toContain("marc_wrap");
  });
});

// ============================================================================
// Exported constants
// ============================================================================

describe("exported constants", () => {
  it("MARC_SEPOLIA_ADDRESSES has all valid addresses", () => {
    expect(MARC_SEPOLIA_ADDRESSES.tokenAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(MARC_SEPOLIA_ADDRESSES.verifierAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(MARC_SEPOLIA_ADDRESSES.usdcAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("TOKEN_ABI includes key functions", () => {
    const abiStr = TOKEN_ABI.join(" ");
    expect(abiStr).toContain("confidentialTransfer");
    expect(abiStr).toContain("wrap");
    expect(abiStr).toContain("unwrap");
    expect(abiStr).toContain("confidentialBalanceOf");
  });

  it("VERIFIER_ABI includes key functions", () => {
    const abiStr = VERIFIER_ABI.join(" ");
    expect(abiStr).toContain("recordPayment");
    expect(abiStr).toContain("usedNonces");
    expect(abiStr).toContain("payAndRecord");
  });

  it("USDC_ABI includes approve and balanceOf", () => {
    const abiStr = USDC_ABI.join(" ");
    expect(abiStr).toContain("approve");
    expect(abiStr).toContain("balanceOf");
  });
});

// ============================================================================
// Input schema validation
// ============================================================================

describe("validateParams", () => {
  const skill = new MarcA2ASkill();

  it("returns error for unknown action", () => {
    const errors = skill.validateParams("bad", {});
    expect(errors).toContain("Unknown action: bad");
  });

  it("returns error when params is null", () => {
    const errors = skill.validateParams("marc_wrap", null);
    expect(errors).toContain("params must be a non-null object");
  });

  it("returns error for missing required field on marc_wrap", () => {
    const errors = skill.validateParams("marc_wrap", {});
    expect(errors).toContain("Missing required field: amount");
  });

  it("returns error for missing required fields on marc_transfer", () => {
    const errors = skill.validateParams("marc_transfer", {});
    expect(errors).toContain("Missing required field: to");
    expect(errors).toContain("Missing required field: amount");
  });

  it("returns error for missing required fields on marc_pay", () => {
    const errors = skill.validateParams("marc_pay", {});
    expect(errors).toContain("Missing required field: server");
    expect(errors).toContain("Missing required field: amount");
  });

  it("returns no errors for valid marc_balance (no required fields)", () => {
    const errors = skill.validateParams("marc_balance", {});
    expect(errors).toHaveLength(0);
  });

  it("returns error for invalid address field", () => {
    const errors = skill.validateParams("marc_transfer", {
      to: "0xinvalid",
      amount: "1000000",
    });
    expect(errors.some((e) => e.includes("Invalid address for to"))).toBe(true);
  });

  it("returns error for non-numeric amount", () => {
    const errors = skill.validateParams("marc_wrap", { amount: "not-a-number" });
    expect(errors.some((e) => e.includes("not a valid integer"))).toBe(true);
  });

  it("returns error for zero amount", () => {
    const errors = skill.validateParams("marc_wrap", { amount: "0" });
    expect(errors).toContain("amount must be > 0");
  });

  it("passes valid marc_wrap params", () => {
    const errors = skill.validateParams("marc_wrap", { amount: "1000000" });
    expect(errors).toHaveLength(0);
  });

  it("passes valid marc_transfer params with addresses", () => {
    const errors = skill.validateParams("marc_transfer", {
      to: VALID_ADDRESS_B,
      amount: "500000",
      tokenAddress: VALID_TOKEN,
    });
    expect(errors).toHaveLength(0);
  });
});

// ============================================================================
// marc_wrap handler
// ============================================================================

describe("handleWrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApprove.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({ hash: "0xapprove", status: 1 }),
    });
    mockWrap.mockResolvedValue({
      hash: "0xwrap123",
      wait: vi.fn().mockResolvedValue({ hash: "0xwrap123", blockNumber: 100, status: 1 }),
    });
  });

  it("wraps USDC successfully via A2A", async () => {
    const result = await handleWrap(
      { amount: "1000000", tokenAddress: VALID_TOKEN, usdcAddress: VALID_USDC },
      createContext()
    );

    expect(result.success).toBe(true);
    expect(result.data.action).toBe("wrap");
    expect(result.data.txHash).toBe("0xwrap123");
    expect(result.data.amount).toBe("1000000");
    expect(result.data.to).toBe(VALID_ADDRESS_A);
    expect(mockApprove).toHaveBeenCalledWith(VALID_TOKEN, 1_000_000n);
    expect(mockWrap).toHaveBeenCalledWith(VALID_ADDRESS_A, 1_000_000n);
  });

  it("wraps USDC to custom recipient", async () => {
    const result = await handleWrap(
      { amount: "500000", to: VALID_ADDRESS_B, tokenAddress: VALID_TOKEN, usdcAddress: VALID_USDC },
      createContext()
    );

    expect(result.success).toBe(true);
    expect(result.data.to).toBe(VALID_ADDRESS_B);
  });

  it("uses default Sepolia addresses when not provided", async () => {
    const result = await handleWrap({ amount: "1000000" }, createContext());
    expect(result.success).toBe(true);
    // The mock Contract is called with the default addresses
    expect(result.data.txHash).toBe("0xwrap123");
  });

  it("returns error on zero amount", async () => {
    const result = await handleWrap({ amount: "0" }, createContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("must be > 0");
  });

  it("returns error on tx revert", async () => {
    mockWrap.mockResolvedValue({
      hash: "0xfail",
      wait: vi.fn().mockResolvedValue({ hash: "0xfail", status: 0 }),
    });

    const result = await handleWrap({ amount: "1000000" }, createContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Wrap transaction reverted");
  });
});

// ============================================================================
// marc_unwrap handler
// ============================================================================

describe("handleUnwrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUnwrap.mockResolvedValue({
      hash: "0xunwrap123",
      wait: vi.fn().mockResolvedValue({ hash: "0xunwrap123", blockNumber: 200, status: 1 }),
    });
  });

  it("initiates unwrap successfully", async () => {
    const result = await handleUnwrap({ amount: "1000000", tokenAddress: VALID_TOKEN }, createContext());

    expect(result.success).toBe(true);
    expect(result.data.action).toBe("unwrap_requested");
    expect(result.data.txHash).toBe("0xunwrap123");
    expect(result.data.note).toContain("KMS");
  });

  it("returns error when fhevmInstance is missing", async () => {
    const result = await handleUnwrap(
      { amount: "1000000", tokenAddress: VALID_TOKEN },
      createContext({ noFhevm: true })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("fhevmInstance is required");
  });

  it("returns error on zero amount", async () => {
    const result = await handleUnwrap({ amount: "0" }, createContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("must be > 0");
  });

  it("returns error on tx revert", async () => {
    mockUnwrap.mockResolvedValue({
      hash: "0xfail",
      wait: vi.fn().mockResolvedValue({ hash: "0xfail", status: 0 }),
    });

    const result = await handleUnwrap({ amount: "1000000" }, createContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unwrap transaction reverted");
  });

  it("handles FHE encryption returning no handles", async () => {
    const ctx = createContext();
    (ctx.fhevmInstance!.createEncryptedInput as any) = vi.fn().mockReturnValue({
      add64: vi.fn(),
      encrypt: vi.fn().mockResolvedValue({ handles: [], inputProof: "0x00" }),
    });

    const result = await handleUnwrap({ amount: "1000000" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("FHE encryption returned no handles");
  });
});

// ============================================================================
// marc_transfer handler
// ============================================================================

describe("handleTransfer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfidentialTransfer.mockResolvedValue({
      hash: "0xtransfer123",
      wait: vi.fn().mockResolvedValue({ hash: "0xtransfer123", blockNumber: 300, status: 1 }),
    });
  });

  it("transfers encrypted cUSDC successfully", async () => {
    const result = await handleTransfer(
      { to: VALID_ADDRESS_B, amount: "500000", tokenAddress: VALID_TOKEN },
      createContext()
    );

    expect(result.success).toBe(true);
    expect(result.data.action).toBe("confidential_transfer");
    expect(result.data.txHash).toBe("0xtransfer123");
    expect(result.data.to).toBe(VALID_ADDRESS_B);
    expect(result.data.encryptedHandle).toBe("0x" + "ff".repeat(32));
  });

  it("returns error when fhevmInstance is missing", async () => {
    const result = await handleTransfer({ to: VALID_ADDRESS_B, amount: "500000" }, createContext({ noFhevm: true }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("fhevmInstance is required");
  });

  it("returns error on invalid recipient address", async () => {
    const result = await handleTransfer(
      { to: "0x0000000000000000000000000000000000000000", amount: "500000" },
      createContext()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid to");
  });

  it("returns error on amount exceeding uint64 max", async () => {
    const overflowAmount = (BigInt("0xFFFFFFFFFFFFFFFF") + 1n).toString();
    const result = await handleTransfer({ to: VALID_ADDRESS_B, amount: overflowAmount }, createContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("exceeds uint64 max");
  });

  it("returns error on tx revert", async () => {
    mockConfidentialTransfer.mockResolvedValue({
      hash: "0xfail",
      wait: vi.fn().mockResolvedValue({ hash: "0xfail", status: 0 }),
    });

    const result = await handleTransfer({ to: VALID_ADDRESS_B, amount: "500000" }, createContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("Confidential transfer reverted");
  });
});

// ============================================================================
// marc_balance handler
// ============================================================================

describe("handleBalance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfidentialBalanceOf.mockResolvedValue("0x" + "aa".repeat(32));
  });

  it("returns non-zero balance handle", async () => {
    const result = await handleBalance({ tokenAddress: VALID_TOKEN }, createContext());

    expect(result.success).toBe(true);
    expect(result.data.action).toBe("balance");
    expect(result.data.address).toBe(VALID_ADDRESS_A);
    expect(result.data.hasEncryptedBalance).toBe(true);
    expect(result.data.note).toContain("Non-zero");
  });

  it("returns zero balance handle", async () => {
    mockConfidentialBalanceOf.mockResolvedValue("0x" + "00".repeat(32));

    const result = await handleBalance({ tokenAddress: VALID_TOKEN }, createContext());

    expect(result.success).toBe(true);
    expect(result.data.hasEncryptedBalance).toBe(false);
    expect(result.data.note).toContain("Zero balance");
  });

  it("handles confidentialBalanceOf failure gracefully", async () => {
    mockConfidentialBalanceOf.mockRejectedValue(new Error("not available"));

    const result = await handleBalance({ tokenAddress: VALID_TOKEN }, createContext());

    expect(result.success).toBe(true);
    expect(result.data.hasEncryptedBalance).toBe(false);
  });

  it("queries custom address", async () => {
    const result = await handleBalance({ address: VALID_ADDRESS_B, tokenAddress: VALID_TOKEN }, createContext());

    expect(result.success).toBe(true);
    expect(result.data.address).toBe(VALID_ADDRESS_B);
  });

  it("uses default Sepolia token address", async () => {
    const result = await handleBalance({}, createContext());
    expect(result.success).toBe(true);
  });

  it("returns error on invalid custom address", async () => {
    const result = await handleBalance({ address: "0xinvalid", tokenAddress: VALID_TOKEN }, createContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid address");
  });
});

// ============================================================================
// marc_pay handler
// ============================================================================

describe("handlePay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfidentialTransfer.mockResolvedValue({
      hash: "0xtransfer_pay",
      wait: vi.fn().mockResolvedValue({ hash: "0xtransfer_pay", blockNumber: 400, status: 1 }),
    });
    mockRecordPayment.mockResolvedValue({
      hash: "0xverifier_pay",
      wait: vi.fn().mockResolvedValue({ hash: "0xverifier_pay", blockNumber: 401, status: 1 }),
    });
  });

  it("completes full x402 payment flow", async () => {
    const result = await handlePay(
      {
        server: VALID_ADDRESS_B,
        amount: "1000000",
        tokenAddress: VALID_TOKEN,
        verifierAddress: VALID_VERIFIER,
      },
      createContext()
    );

    expect(result.success).toBe(true);
    expect(result.data.action).toBe("x402_payment");
    expect(result.data.transferTxHash).toBe("0xtransfer_pay");
    expect(result.data.verifierTxHash).toBe("0xverifier_pay");
    expect(result.data.nonce).toBeDefined();
    expect(result.data.server).toBe(VALID_ADDRESS_B);
    expect(result.data.amount).toBe("1000000");
  });

  it("returns error when fhevmInstance is missing", async () => {
    const result = await handlePay({ server: VALID_ADDRESS_B, amount: "1000000" }, createContext({ noFhevm: true }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("fhevmInstance is required");
  });

  it("returns error on invalid server address", async () => {
    const result = await handlePay(
      { server: "0x0000000000000000000000000000000000000000", amount: "1000000" },
      createContext()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid server");
  });

  it("returns error on zero amount", async () => {
    const result = await handlePay({ server: VALID_ADDRESS_B, amount: "0" }, createContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("must be > 0");
  });

  it("returns error when transfer reverts", async () => {
    mockConfidentialTransfer.mockResolvedValue({
      hash: "0xfail",
      wait: vi.fn().mockResolvedValue({ hash: "0xfail", status: 0 }),
    });

    const result = await handlePay({ server: VALID_ADDRESS_B, amount: "1000000" }, createContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("Payment transfer reverted");
  });

  it("returns error when verifier recordPayment reverts", async () => {
    mockRecordPayment.mockResolvedValue({
      hash: "0xvfail",
      wait: vi.fn().mockResolvedValue({ hash: "0xvfail", status: 0 }),
    });

    const result = await handlePay({ server: VALID_ADDRESS_B, amount: "1000000" }, createContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("Verifier recordPayment failed");
    expect(result.data?.transferTxHash).toBe("0xtransfer_pay");
  });

  it("uses default Sepolia addresses when not provided", async () => {
    const result = await handlePay({ server: VALID_ADDRESS_B, amount: "1000000" }, createContext());

    expect(result.success).toBe(true);
    expect(result.data.action).toBe("x402_payment");
  });
});

// ============================================================================
// executeAction integration
// ============================================================================

describe("executeAction integration", () => {
  const skill = new MarcA2ASkill();

  beforeEach(() => {
    vi.clearAllMocks();
    mockApprove.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({ hash: "0xapprove", status: 1 }),
    });
    mockWrap.mockResolvedValue({
      hash: "0xwrap_exec",
      wait: vi.fn().mockResolvedValue({ hash: "0xwrap_exec", blockNumber: 50, status: 1 }),
    });
    mockConfidentialBalanceOf.mockResolvedValue("0x" + "bb".repeat(32));
  });

  it("executes marc_wrap via skill.executeAction", async () => {
    const result = await skill.executeAction("marc_wrap", { amount: "2000000" }, createContext());

    expect(result.success).toBe(true);
    expect(result.data.action).toBe("wrap");
    expect(result.data.txHash).toBe("0xwrap_exec");
  });

  it("executes marc_balance via skill.executeAction", async () => {
    const result = await skill.executeAction("marc_balance", { tokenAddress: VALID_TOKEN }, createContext());

    expect(result.success).toBe(true);
    expect(result.data.action).toBe("balance");
  });
});

// ============================================================================
// MarcA2AError tests
// ============================================================================

describe("MarcA2AError", () => {
  it("includes message and name", () => {
    const err = new MarcA2AError("test error");
    expect(err.message).toBe("test error");
    expect(err.name).toBe("MarcA2AError");
  });

  it("includes details", () => {
    const err = new MarcA2AError("test", { txHash: "0x123" });
    expect(err.details).toEqual({ txHash: "0x123" });
  });

  it("is an instance of Error", () => {
    const err = new MarcA2AError("test");
    expect(err).toBeInstanceOf(Error);
  });
});
