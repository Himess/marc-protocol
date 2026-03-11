import { describe, it, expect, vi } from "vitest";
import { Interface } from "ethers";
import {
  ACP_ABI,
  encodeJobDescription,
  calculatePlatformFee,
  createJobParams,
  parseJobCompletedEvent,
  connectACP,
  createJob,
  setBudget,
  fundJob,
  submitDeliverable,
  completeJob,
  rejectJob,
  claimRefund,
  getJob,
} from "../src/erc8183/index.js";

// ============================================================================
// ACP_ABI
// ============================================================================

describe("ACP_ABI", () => {
  it("has createJob function", () => {
    const hasCreateJob = ACP_ABI.some((entry) =>
      entry.includes("function createJob")
    );
    expect(hasCreateJob).toBe(true);
  });

  it("has complete and fund functions", () => {
    const hasComplete = ACP_ABI.some((entry) =>
      entry.includes("function complete")
    );
    const hasFund = ACP_ABI.some((entry) =>
      entry.includes("function fund")
    );
    expect(hasComplete).toBe(true);
    expect(hasFund).toBe(true);
  });

  it("has all lifecycle events", () => {
    const abiStr = ACP_ABI.join(" ");
    expect(abiStr).toContain("event JobCreated");
    expect(abiStr).toContain("event JobCompleted");
    expect(abiStr).toContain("event PaymentReleased");
    expect(abiStr).toContain("event JobFunded");
    expect(abiStr).toContain("event JobRejected");
    expect(abiStr).toContain("event Refunded");
  });
});

// ============================================================================
// encodeJobDescription
// ============================================================================

describe("encodeJobDescription", () => {
  it("formats title, details, and requirements", () => {
    const result = encodeJobDescription(
      "Data Analysis",
      "Analyze Q4 sales data",
      ["Python", "pandas"]
    );

    expect(result).toContain("[Title] Data Analysis");
    expect(result).toContain("[Details] Analyze Q4 sales data");
    expect(result).toContain("[Requirements] Python; pandas");
  });

  it("separates sections with pipe delimiter", () => {
    const result = encodeJobDescription(
      "Task",
      "Description",
      ["Req1"]
    );

    expect(result).toBe("[Title] Task | [Details] Description | [Requirements] Req1");
  });

  it("handles empty fields gracefully", () => {
    const result = encodeJobDescription("", "", []);
    expect(result).toBe("");
  });

  it("handles title only", () => {
    const result = encodeJobDescription("My Job", "", []);
    expect(result).toBe("[Title] My Job");
  });

  it("handles multiple requirements with semicolons", () => {
    const result = encodeJobDescription(
      "Job",
      "Details",
      ["Solidity", "TypeScript", "Hardhat", "Foundry"]
    );

    expect(result).toContain("Solidity; TypeScript; Hardhat; Foundry");
  });
});

// ============================================================================
// calculatePlatformFee
// ============================================================================

describe("calculatePlatformFee", () => {
  it("1% of 100 USDC = 1 USDC", () => {
    const budget = 100_000_000n; // 100 USDC (6 decimals)
    const { fee, payout } = calculatePlatformFee(budget);

    expect(fee).toBe(1_000_000n); // 1 USDC
    expect(payout).toBe(99_000_000n); // 99 USDC
  });

  it("1% of 1 USDC = 0.01 USDC", () => {
    const budget = 1_000_000n; // 1 USDC
    const { fee, payout } = calculatePlatformFee(budget);

    expect(fee).toBe(10_000n); // 0.01 USDC
    expect(payout).toBe(990_000n); // 0.99 USDC
  });

  it("handles zero budget", () => {
    const { fee, payout } = calculatePlatformFee(0n);

    expect(fee).toBe(0n);
    expect(payout).toBe(0n);
  });

  it("handles large amounts (10,000 USDC)", () => {
    const budget = 10_000_000_000n; // 10,000 USDC
    const { fee, payout } = calculatePlatformFee(budget);

    expect(fee).toBe(100_000_000n); // 100 USDC
    expect(payout).toBe(9_900_000_000n); // 9,900 USDC
  });

  it("fee + payout always equals budget", () => {
    const budgets = [1n, 99n, 1_000_000n, 50_000_000n, 999_999_999n];
    for (const budget of budgets) {
      const { fee, payout } = calculatePlatformFee(budget);
      expect(fee + payout).toBe(budget);
    }
  });
});

// ============================================================================
// createJobParams
// ============================================================================

describe("createJobParams", () => {
  it("returns correct provider and evaluator", () => {
    const params = createJobParams({
      provider: "0xProviderAddr",
      evaluator: "0xEvaluatorAddr",
      expiredAt: 1700000000,
      title: "Test",
      details: "Details",
      requirements: [],
    });

    expect(params.provider).toBe("0xProviderAddr");
    expect(params.evaluator).toBe("0xEvaluatorAddr");
  });

  it("returns correct expiry", () => {
    const params = createJobParams({
      provider: "0xProvider",
      evaluator: "0xEval",
      expiredAt: 1700000000,
      title: "T",
      details: "D",
      requirements: ["R"],
    });

    expect(params.expiredAt).toBe(1700000000);
  });

  it("encodes description from title, details, and requirements", () => {
    const params = createJobParams({
      provider: "0xP",
      evaluator: "0xE",
      expiredAt: 1700000000,
      title: "Data Job",
      details: "Analyze dataset",
      requirements: ["Python", "SQL"],
    });

    expect(params.description).toContain("[Title] Data Job");
    expect(params.description).toContain("[Details] Analyze dataset");
    expect(params.description).toContain("Python; SQL");
  });

  it("uses zero address as default hook", () => {
    const params = createJobParams({
      provider: "0xP",
      evaluator: "0xE",
      expiredAt: 1700000000,
      title: "T",
      details: "D",
      requirements: [],
    });

    expect(params.hook).toBe("0x0000000000000000000000000000000000000000");
  });

  it("uses custom hook when provided", () => {
    const params = createJobParams({
      provider: "0xP",
      evaluator: "0xE",
      expiredAt: 1700000000,
      title: "T",
      details: "D",
      requirements: [],
      hook: "0xHookAddress",
    });

    expect(params.hook).toBe("0xHookAddress");
  });
});

// ============================================================================
// parseJobCompletedEvent
// ============================================================================

describe("parseJobCompletedEvent", () => {
  it("extracts JobCompleted data from receipt logs", () => {
    const receipt = {
      logs: [
        {
          topics: [],
          data: "0x",
          fragment: { name: "JobCompleted" },
          args: [1n, "0xEvaluatorAddr", "0xreasonhash"],
        },
        {
          topics: [],
          data: "0x",
          fragment: { name: "PaymentReleased" },
          args: [1n, "0xProviderAddr", 99_000_000n],
        },
      ],
    };

    const result = parseJobCompletedEvent(receipt);

    expect(result.jobCompleted).not.toBeNull();
    expect(result.jobCompleted!.jobId).toBe(1n);
    expect(result.jobCompleted!.evaluator).toBe("0xEvaluatorAddr");
    expect(result.jobCompleted!.reason).toBe("0xreasonhash");
  });

  it("extracts PaymentReleased data from receipt logs", () => {
    const receipt = {
      logs: [
        {
          topics: [],
          data: "0x",
          fragment: { name: "JobCompleted" },
          args: [5n, "0xEval", "0xreason"],
        },
        {
          topics: [],
          data: "0x",
          fragment: { name: "PaymentReleased" },
          args: [5n, "0xProv", 49_500_000n],
        },
      ],
    };

    const result = parseJobCompletedEvent(receipt);

    expect(result.paymentReleased).not.toBeNull();
    expect(result.paymentReleased!.jobId).toBe(5n);
    expect(result.paymentReleased!.provider).toBe("0xProv");
    expect(result.paymentReleased!.amount).toBe(49_500_000n);
  });

  it("returns null when events are not present", () => {
    const receipt = {
      logs: [
        {
          topics: [],
          data: "0x",
          fragment: { name: "Transfer" },
          args: ["0xA", "0xB", 1000n],
        },
      ],
    };

    const result = parseJobCompletedEvent(receipt);

    expect(result.jobCompleted).toBeNull();
    expect(result.paymentReleased).toBeNull();
  });

  it("handles empty logs", () => {
    const result = parseJobCompletedEvent({ logs: [] });

    expect(result.jobCompleted).toBeNull();
    expect(result.paymentReleased).toBeNull();
  });
});

// ============================================================================
// Contract interaction functions
// ============================================================================

/** Helper to build a mock ACP contract with method stubs */
function createMockACP(overrides: Record<string, any> = {}) {
  const iface = new Interface(ACP_ABI);

  // Build a fake receipt with encoded logs
  function makeReceipt(hash: string, eventName: string, args: any[]) {
    const fragment = iface.getEvent(eventName);
    if (!fragment) throw new Error(`Event ${eventName} not found in ABI`);
    const log = iface.encodeEventLog(fragment, args);
    return {
      hash,
      logs: [{ topics: [...log.topics], data: log.data }],
    };
  }

  const mockTx = (receipt: any) => ({
    wait: vi.fn().mockResolvedValue(receipt),
  });

  const contract: any = {
    interface: iface,
    createJob: vi.fn(),
    setBudget: vi.fn(),
    fund: vi.fn(),
    submit: vi.fn(),
    complete: vi.fn(),
    reject: vi.fn(),
    claimRefund: vi.fn(),
    getJob: vi.fn(),
    ...overrides,
  };

  return { contract, mockTx, makeReceipt };
}

describe("connectACP", () => {
  it("returns a Contract instance", () => {
    // Use a minimal mock signer (just needs to be truthy for Contract constructor)
    const mockSigner: any = { provider: null, getAddress: vi.fn() };
    const acp = connectACP("0x1234567890abcdef1234567890abcdef12345678", mockSigner);
    expect(acp).toBeDefined();
    expect(acp.interface).toBeDefined();
  });
});

describe("createJob", () => {
  it("returns jobId and txHash from JobCreated event", async () => {
    const { contract, mockTx, makeReceipt } = createMockACP();
    const receipt = makeReceipt(
      "0xtxhash1",
      "JobCreated",
      [
        42n,
        "0x0000000000000000000000000000000000000001", // client (indexed)
        "0x0000000000000000000000000000000000000002", // provider (indexed)
        "0x0000000000000000000000000000000000000003", // evaluator
        1700000000n, // expiredAt
      ]
    );
    contract.createJob.mockResolvedValue(mockTx(receipt));

    const result = await createJob(contract, {
      provider: "0x0000000000000000000000000000000000000002",
      evaluator: "0x0000000000000000000000000000000000000003",
      expiredAt: 1700000000,
      description: "test",
      hook: "0x0000000000000000000000000000000000000000",
    });

    expect(result.jobId).toBe(42n);
    expect(result.txHash).toBe("0xtxhash1");
  });

  it("throws if JobCreated event not found", async () => {
    const { contract, mockTx } = createMockACP();
    const receipt = { hash: "0xtxhash2", logs: [] };
    contract.createJob.mockResolvedValue(mockTx(receipt));

    await expect(
      createJob(contract, {
        provider: "0x0000000000000000000000000000000000000002",
        evaluator: "0x0000000000000000000000000000000000000003",
        expiredAt: 1700000000,
        description: "test",
        hook: "0x0000000000000000000000000000000000000000",
      })
    ).rejects.toThrow("JobCreated event not found");
  });
});

describe("setBudget", () => {
  it("calls setBudget and returns tx hash", async () => {
    const { contract, mockTx } = createMockACP();
    const receipt = { hash: "0xbudgethash" };
    contract.setBudget.mockResolvedValue(mockTx(receipt));

    const hash = await setBudget(contract, 1n, 50_000_000n);
    expect(hash).toBe("0xbudgethash");
    expect(contract.setBudget).toHaveBeenCalledWith(1n, 50_000_000n);
  });
});

describe("fundJob", () => {
  it("calls fund and returns tx hash", async () => {
    const { contract, mockTx } = createMockACP();
    const receipt = { hash: "0xfundhash" };
    contract.fund.mockResolvedValue(mockTx(receipt));

    const hash = await fundJob(contract, 1n, 50_000_000n);
    expect(hash).toBe("0xfundhash");
    expect(contract.fund).toHaveBeenCalledWith(1n, 50_000_000n);
  });
});

describe("submitDeliverable", () => {
  it("calls submit and returns tx hash", async () => {
    const { contract, mockTx } = createMockACP();
    const receipt = { hash: "0xsubmithash" };
    contract.submit.mockResolvedValue(mockTx(receipt));

    const hash = await submitDeliverable(contract, 5n, "0xdeliverable");
    expect(hash).toBe("0xsubmithash");
    expect(contract.submit).toHaveBeenCalledWith(5n, "0xdeliverable");
  });
});

describe("completeJob", () => {
  it("calls complete and parses events", async () => {
    const { contract, mockTx } = createMockACP();
    // completeJob calls parseJobCompletedEvent which expects fragment-based logs
    const receipt = {
      hash: "0xcompletehash",
      logs: [
        {
          topics: [],
          data: "0x",
          fragment: { name: "JobCompleted" },
          args: [10n, "0xEval", "0xreason"],
        },
        {
          topics: [],
          data: "0x",
          fragment: { name: "PaymentReleased" },
          args: [10n, "0xProv", 99_000_000n],
        },
      ],
    };
    contract.complete.mockResolvedValue(mockTx(receipt));

    const result = await completeJob(contract, 10n, "0xreason");
    expect(result.txHash).toBe("0xcompletehash");
    expect(result.jobCompleted).not.toBeNull();
    expect(result.jobCompleted!.jobId).toBe(10n);
    expect(result.paymentReleased).not.toBeNull();
    expect(result.paymentReleased!.amount).toBe(99_000_000n);
  });
});

describe("rejectJob", () => {
  it("calls reject and returns tx hash", async () => {
    const { contract, mockTx } = createMockACP();
    const receipt = { hash: "0xrejecthash" };
    contract.reject.mockResolvedValue(mockTx(receipt));

    const hash = await rejectJob(contract, 3n, "0xreason");
    expect(hash).toBe("0xrejecthash");
    expect(contract.reject).toHaveBeenCalledWith(3n, "0xreason");
  });
});

describe("claimRefund", () => {
  it("calls claimRefund and returns tx hash", async () => {
    const { contract, mockTx } = createMockACP();
    const receipt = { hash: "0xrefundhash" };
    contract.claimRefund.mockResolvedValue(mockTx(receipt));

    const hash = await claimRefund(contract, 7n);
    expect(hash).toBe("0xrefundhash");
    expect(contract.claimRefund).toHaveBeenCalledWith(7n);
  });
});

describe("getJob", () => {
  it("returns parsed job struct", async () => {
    const { contract } = createMockACP();
    contract.getJob.mockResolvedValue([
      "0xClientAddr",
      "0xProviderAddr",
      "0xEvalAddr",
      50_000_000n,
      1700000000n,
      2, // status: funded
      "Test description",
      "0xdeliverable",
      "0x0000000000000000000000000000000000000000",
    ]);

    const job = await getJob(contract, 1n);

    expect(job.client).toBe("0xClientAddr");
    expect(job.provider).toBe("0xProviderAddr");
    expect(job.evaluator).toBe("0xEvalAddr");
    expect(job.budget).toBe(50_000_000n);
    expect(job.expiredAt).toBe(1700000000n);
    expect(job.status).toBe(2);
    expect(job.description).toBe("Test description");
    expect(job.deliverable).toBe("0xdeliverable");
    expect(job.hook).toBe("0x0000000000000000000000000000000000000000");
  });

  it("accepts number jobId", async () => {
    const { contract } = createMockACP();
    contract.getJob.mockResolvedValue([
      "0xA", "0xB", "0xC", 0n, 0n, 0, "", "0x00", "0x00",
    ]);

    await getJob(contract, 42);
    expect(contract.getJob).toHaveBeenCalledWith(42);
  });
});
