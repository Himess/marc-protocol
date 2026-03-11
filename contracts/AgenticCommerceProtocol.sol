// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IACP.sol";

/// @title AgenticCommerceProtocol — ERC-8183 Job Escrow for Agent Commerce
/// @notice Minimal escrow: client locks funds, provider submits work, evaluator confirms.
///         Platform fee: 1% on completion. Fee goes to treasury.
/// @dev V4.2: Integrates with FHE x402 via IACPHook for confidential escrow.
///      Hook callbacks are capped at 100,000 gas and wrapped in try/catch.
///      Hooks that exceed this limit will silently fail without blocking the operation.
contract AgenticCommerceProtocol is IACP, Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════

    IERC20 public immutable paymentToken;
    uint256 public constant PLATFORM_FEE_BPS = 100; // 1%
    uint256 public constant BPS = 10_000;

    // ═══════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════

    address public treasury;
    uint256 private _nextJobId = 1;
    mapping(uint256 => Job) private _jobs;

    // ═══════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════

    constructor(IERC20 _paymentToken, address _treasury) Ownable(msg.sender) {
        if (address(_paymentToken) == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        paymentToken = _paymentToken;
        treasury = _treasury;
        emit TreasuryUpdated(address(0), _treasury);
    }

    // ═══════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════

    modifier jobExists(uint256 jobId) {
        if (_jobs[jobId].client == address(0)) revert JobNotFound();
        _;
    }

    // ═══════════════════════════════════════
    // JOB LIFECYCLE
    // ═══════════════════════════════════════

    /// @notice Create a new job with optional provider, evaluator, expiry, and hook.
    /// @param provider The address that will deliver the work (can be set later)
    /// @param evaluator The address that approves or rejects the deliverable
    /// @param expiredAt Unix timestamp after which the client can claim a refund
    /// @param description Human-readable job description
    /// @param hook Optional IACPHook contract for lifecycle callbacks
    /// @return jobId The ID of the newly created job
    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external whenNotPaused returns (uint256 jobId) {
        if (evaluator == address(0)) revert InvalidEvaluator();
        if (evaluator == msg.sender) revert SelfDealing();
        if (expiredAt <= block.timestamp) revert InvalidExpiry();

        jobId = _nextJobId++;
        Job storage job = _jobs[jobId];
        job.client = msg.sender;
        job.provider = provider;
        job.evaluator = evaluator;
        job.expiredAt = expiredAt;
        job.description = description;
        job.status = JobStatus.Open;
        job.hook = hook;

        if (hook != address(0)) {
            try IACPHook(hook).afterAction{gas: 100_000}(jobId, this.createJob.selector, abi.encode(msg.sender, provider, evaluator)) {} catch {}
        }

        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt);
    }

    /// @notice Set or update the provider for an open job. Client only.
    /// @param jobId The job to update
    /// @param provider The new provider address
    function setProvider(uint256 jobId, address provider) external jobExists(jobId) {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.client) revert Unauthorized();
        if (job.status != JobStatus.Open) revert InvalidStatus();
        if (provider == address(0)) revert InvalidProvider();
        job.provider = provider;
        emit ProviderSet(jobId, provider);
    }

    /// @notice Set or update the budget for an open job. Client only.
    /// @param jobId The job to update
    /// @param amount The budget amount in payment token units
    function setBudget(uint256 jobId, uint256 amount) external jobExists(jobId) {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.client) revert Unauthorized();
        if (job.status != JobStatus.Open) revert InvalidStatus();
        if (amount == 0) revert ZeroBudget();
        job.budget = amount;
        emit BudgetSet(jobId, amount);
    }

    /// @notice Fund an open job by transferring the budget amount. Client only.
    ///         The expectedBudget parameter prevents front-running budget changes.
    /// @param jobId The job to fund
    /// @param expectedBudget Must match the current budget (prevents front-running)
    function fund(uint256 jobId, uint256 expectedBudget) external nonReentrant jobExists(jobId) whenNotPaused {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.client) revert Unauthorized();
        if (job.status != JobStatus.Open) revert InvalidStatus();
        if (job.budget == 0) revert ZeroBudget();
        if (job.budget != expectedBudget) revert BudgetMismatch();

        job.status = JobStatus.Funded;
        paymentToken.safeTransferFrom(msg.sender, address(this), job.budget);

        if (job.hook != address(0)) {
            try IACPHook(job.hook).afterAction{gas: 100_000}(jobId, this.fund.selector, abi.encode(msg.sender, job.budget)) {} catch {}
        }

        emit JobFunded(jobId, msg.sender, job.budget);
    }

    /// @notice Submit a deliverable for a funded job. Provider only.
    /// @param jobId The job to submit work for
    /// @param deliverable Content hash or IPFS CID of the deliverable
    function submit(uint256 jobId, bytes32 deliverable) external jobExists(jobId) whenNotPaused {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.provider) revert Unauthorized();
        if (job.status != JobStatus.Funded) revert InvalidStatus();

        job.status = JobStatus.Submitted;
        job.deliverable = deliverable;

        if (job.hook != address(0)) {
            try IACPHook(job.hook).afterAction{gas: 100_000}(jobId, this.submit.selector, abi.encode(msg.sender, deliverable)) {} catch {}
        }

        emit JobSubmitted(jobId, msg.sender, deliverable);
    }

    /// @notice Complete a submitted job and release payment. Evaluator only.
    ///         Platform fee (1%) is deducted and sent to treasury.
    /// @param jobId The job to complete
    /// @param reason Reason hash for the completion decision
    function complete(uint256 jobId, bytes32 reason) external nonReentrant jobExists(jobId) whenNotPaused {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.evaluator) revert Unauthorized();
        if (job.status != JobStatus.Submitted) revert InvalidStatus();

        job.status = JobStatus.Completed;

        // Calculate platform fee: 1%
        uint256 fee = (job.budget * PLATFORM_FEE_BPS) / BPS;
        uint256 payout = job.budget - fee;

        // Pay provider
        paymentToken.safeTransfer(job.provider, payout);
        // Pay treasury
        if (fee > 0) {
            paymentToken.safeTransfer(treasury, fee);
        }

        if (job.hook != address(0)) {
            try IACPHook(job.hook).afterAction{gas: 100_000}(jobId, this.complete.selector, abi.encode(msg.sender, reason, payout, fee)) {} catch {}
        }

        emit JobCompleted(jobId, msg.sender, reason);
        emit PaymentReleased(jobId, job.provider, payout);
    }

    /// @notice Reject a job and refund the client if funded.
    ///         Client can reject Open or Funded jobs.
    ///         Evaluator can reject Funded or Submitted jobs.
    ///         Note: At Funded status, both client and evaluator may race to reject.
    ///         The first transaction wins; the second reverts with InvalidStatus.
    /// @param jobId The job to reject
    /// @param reason Reason hash for the rejection
    function reject(uint256 jobId, bytes32 reason) external nonReentrant jobExists(jobId) {
        Job storage job = _jobs[jobId];
        bool isClient = msg.sender == job.client;
        bool isEvaluator = msg.sender == job.evaluator;

        if (!isClient && !isEvaluator) revert Unauthorized();

        if (isClient && job.status != JobStatus.Open && job.status != JobStatus.Funded) revert InvalidStatus();
        if (isEvaluator && job.status != JobStatus.Funded && job.status != JobStatus.Submitted) revert InvalidStatus();

        JobStatus previousStatus = job.status;
        job.status = JobStatus.Rejected;

        // Refund if funded
        if (previousStatus == JobStatus.Funded || previousStatus == JobStatus.Submitted) {
            paymentToken.safeTransfer(job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget);
        }

        if (job.hook != address(0)) {
            try IACPHook(job.hook).afterAction{gas: 100_000}(jobId, this.reject.selector, abi.encode(msg.sender, reason)) {} catch {}
        }

        emit JobRejected(jobId, msg.sender, reason);
    }

    /// @notice Claim a refund for an expired job that was funded but not completed.
    /// @param jobId The expired job to claim a refund for
    function claimRefund(uint256 jobId) external nonReentrant jobExists(jobId) {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.client) revert Unauthorized();
        if (block.timestamp < job.expiredAt) revert InvalidStatus();
        if (job.status != JobStatus.Funded && job.status != JobStatus.Submitted) revert InvalidStatus();

        job.status = JobStatus.Expired;
        paymentToken.safeTransfer(job.client, job.budget);

        emit Refunded(jobId, job.client, job.budget);
    }

    // ═══════════════════════════════════════
    // VIEW
    // ═══════════════════════════════════════

    /// @notice Get the full job struct for a given job ID.
    /// @param jobId The job ID to query
    /// @return The Job struct
    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    // ═══════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════

    /// @notice Update the fee treasury address. Owner only.
    /// @param _treasury The new treasury address
    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        address old = treasury;
        treasury = _treasury;
        emit TreasuryUpdated(old, _treasury);
    }

    /// @notice Pause all job lifecycle operations (emergency stop)
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume operations
    function unpause() external onlyOwner {
        _unpause();
    }
}
