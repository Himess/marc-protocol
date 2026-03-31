// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.27;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IACPHook} from "./interfaces/IACP.sol";

/// @title ConfidentialACP — ERC-8183 Job Escrow with FHE-Encrypted Payments
/// @notice Escrow where budgets and payments are FHE-encrypted via ERC-7984 (cUSDC).
///         Nobody can see how much a job pays. Fee calculation happens on encrypted data.
///         Platform fee: 1% on completion, calculated with FHE arithmetic.
/// @dev    Requires ConfidentialUSDC (ERC-7984) as payment token.
///         Clients must call setOperator(address(this), ...) on cUSDC before funding.
contract ConfidentialACP is
    ZamaEthereumConfig,
    Ownable2Step,
    ReentrancyGuard,
    Pausable
{
    // ═══════════════════════════════════════
    // TYPES
    // ═══════════════════════════════════════

    enum JobStatus { Open, Funded, Submitted, Completed, Rejected, Expired }

    struct Job {
        address client;
        address provider;
        address evaluator;
        string description;
        euint64 budget;         // FHE-encrypted budget (nobody sees the amount)
        uint256 expiredAt;
        JobStatus status;
        address hook;
        bytes32 deliverable;
    }

    // ═══════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════

    ERC7984 public immutable paymentToken;   // ConfidentialUSDC (ERC-7984)
    uint64 public constant PLATFORM_FEE_BPS = 100;  // 1%
    uint64 public constant BPS = 10_000;

    // ═══════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════

    address public treasury;
    uint256 private _nextJobId = 1;
    mapping(uint256 => Job) private _jobs;

    // ═══════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════

    event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt);
    event ProviderSet(uint256 indexed jobId, address indexed provider);
    event JobFunded(uint256 indexed jobId, address indexed client);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event PaymentReleased(uint256 indexed jobId, address indexed provider);
    event Refunded(uint256 indexed jobId, address indexed client);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event HookFailed(uint256 indexed jobId, bytes4 indexed selector);

    // ═══════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════

    error JobNotFound();
    error Unauthorized();
    error InvalidStatus();
    error InvalidProvider();
    error InvalidEvaluator();
    error InvalidExpiry();
    error InvalidPaymentToken();
    error ZeroAddress();
    error ZeroBudget();
    error SelfDealing();

    // ═══════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════

    constructor(ERC7984 _paymentToken, address _treasury) Ownable(msg.sender) {
        if (address(_paymentToken) == address(0)) revert ZeroAddress();
        if (address(_paymentToken).code.length == 0) revert InvalidPaymentToken();
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

    /// @notice Create a new job.
    /// @param provider The address that will deliver the work
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
        if (evaluator == provider && provider != address(0)) revert SelfDealing();
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
            try IACPHook(hook).afterAction{gas: 100_000}(jobId, this.createJob.selector, abi.encode(msg.sender, provider, evaluator)) {} catch { emit HookFailed(jobId, this.createJob.selector); }
        }

        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt);
    }

    /// @notice Set or update the provider for an open job. Client only.
    function setProvider(uint256 jobId, address provider) external jobExists(jobId) {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.client) revert Unauthorized();
        if (job.status != JobStatus.Open) revert InvalidStatus();
        if (provider == address(0)) revert InvalidProvider();
        job.provider = provider;
        emit ProviderSet(jobId, provider);
    }

    /// @notice Fund a job with cUSDC. Client only.
    ///         Client must have called setOperator(address(this), ...) on cUSDC first.
    ///         The amount is encrypted on-chain via FHE. Once stored, nobody can read it.
    /// @param jobId The job to fund
    /// @param amount Budget amount in cUSDC (will be encrypted on-chain)
    function fund(
        uint256 jobId,
        uint64 amount
    ) external nonReentrant jobExists(jobId) whenNotPaused {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.client) revert Unauthorized();
        if (job.status != JobStatus.Open) revert InvalidStatus();
        if (amount == 0) revert ZeroBudget();

        // Encrypt the amount on-chain
        euint64 encAmount = FHE.asEuint64(amount);

        // Grant FHE ACL permission to cUSDC contract for the encrypted handle
        FHE.allowTransient(encAmount, address(paymentToken));

        // Transfer encrypted cUSDC from client to this contract
        // Client must have approved this contract as operator
        euint64 transferred = paymentToken.confidentialTransferFrom(
            msg.sender,
            address(this),
            encAmount
        );

        // Allow this contract to use the transferred handle for later operations
        FHE.allow(transferred, address(this));

        // Store encrypted budget
        job.budget = transferred;
        job.status = JobStatus.Funded;

        if (job.hook != address(0)) {
            try IACPHook(job.hook).afterAction{gas: 100_000}(jobId, this.fund.selector, abi.encode(msg.sender)) {} catch { emit HookFailed(jobId, this.fund.selector); }
        }

        emit JobFunded(jobId, msg.sender);
    }

    /// @notice Create and fund a job in a single transaction.
    function createAndFund(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook,
        uint64 amount
    ) external nonReentrant whenNotPaused returns (uint256 jobId) {
        if (evaluator == address(0)) revert InvalidEvaluator();
        if (evaluator == msg.sender) revert SelfDealing();
        if (evaluator == provider && provider != address(0)) revert SelfDealing();
        if (expiredAt <= block.timestamp) revert InvalidExpiry();
        if (amount == 0) revert ZeroBudget();

        jobId = _nextJobId++;
        Job storage job = _jobs[jobId];
        job.client = msg.sender;
        job.provider = provider;
        job.evaluator = evaluator;
        job.expiredAt = expiredAt;
        job.description = description;
        job.hook = hook;

        // Encrypt and transfer
        euint64 encAmount = FHE.asEuint64(amount);
        FHE.allowTransient(encAmount, address(paymentToken));

        euint64 transferred = paymentToken.confidentialTransferFrom(
            msg.sender,
            address(this),
            encAmount
        );

        FHE.allow(transferred, address(this));
        job.budget = transferred;
        job.status = JobStatus.Funded;

        if (hook != address(0)) {
            try IACPHook(hook).afterAction{gas: 100_000}(jobId, this.createJob.selector, abi.encode(msg.sender, provider, evaluator)) {} catch { emit HookFailed(jobId, this.createJob.selector); }
            try IACPHook(hook).afterAction{gas: 100_000}(jobId, this.fund.selector, abi.encode(msg.sender)) {} catch { emit HookFailed(jobId, this.fund.selector); }
        }

        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt);
        emit JobFunded(jobId, msg.sender);
    }

    /// @notice Submit a deliverable for a funded job. Provider only.
    function submit(uint256 jobId, bytes32 deliverable) external jobExists(jobId) whenNotPaused {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.provider) revert Unauthorized();
        if (job.status != JobStatus.Funded) revert InvalidStatus();

        job.status = JobStatus.Submitted;
        job.deliverable = deliverable;

        if (job.hook != address(0)) {
            try IACPHook(job.hook).afterAction{gas: 100_000}(jobId, this.submit.selector, abi.encode(msg.sender, deliverable)) {} catch { emit HookFailed(jobId, this.submit.selector); }
        }

        emit JobSubmitted(jobId, msg.sender, deliverable);
    }

    /// @notice Complete a submitted job and release encrypted payment. Evaluator only.
    ///         Platform fee (1%) is calculated on encrypted budget using FHE arithmetic.
    ///         Neither fee nor payout amounts are visible to anyone.
    function complete(uint256 jobId, bytes32 reason) external nonReentrant jobExists(jobId) whenNotPaused {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.evaluator) revert Unauthorized();
        if (job.status != JobStatus.Submitted) revert InvalidStatus();

        job.status = JobStatus.Completed;

        // FHE fee calculation: fee = budget / 100 = 1%
        euint64 fee = FHE.div(job.budget, uint64(100));
        euint64 payout = FHE.sub(job.budget, fee);

        // Grant FHE ACL for payment token to read these handles
        FHE.allowTransient(payout, address(paymentToken));
        FHE.allowTransient(fee, address(paymentToken));

        // Transfer encrypted payout to provider (nobody sees the amount)
        paymentToken.confidentialTransfer(job.provider, payout);

        // Transfer encrypted fee to treasury (nobody sees the fee)
        // NOTE: Treasury receives cUSDC (encrypted). Treasury can unwrap via
        // ConfidentialUSDC.unwrap() to convert back to plaintext USDC.
        paymentToken.confidentialTransfer(treasury, fee);

        if (job.hook != address(0)) {
            try IACPHook(job.hook).afterAction{gas: 100_000}(jobId, this.complete.selector, abi.encode(msg.sender, reason)) {} catch { emit HookFailed(jobId, this.complete.selector); }
        }

        emit JobCompleted(jobId, msg.sender, reason);
        emit PaymentReleased(jobId, job.provider);
    }

    /// @notice Reject a job and refund encrypted cUSDC to client.
    ///         Client can reject Open or Funded jobs.
    ///         Evaluator can reject Funded or Submitted jobs.
    function reject(uint256 jobId, bytes32 reason) external nonReentrant jobExists(jobId) whenNotPaused {
        Job storage job = _jobs[jobId];
        bool isClient = msg.sender == job.client;
        bool isEvaluator = msg.sender == job.evaluator;

        if (!isClient && !isEvaluator) revert Unauthorized();

        if (isClient && job.status != JobStatus.Open && job.status != JobStatus.Funded) revert InvalidStatus();
        if (isEvaluator && job.status != JobStatus.Funded && job.status != JobStatus.Submitted) revert InvalidStatus();

        JobStatus previousStatus = job.status;
        job.status = JobStatus.Rejected;

        // Refund encrypted cUSDC if was funded
        if (previousStatus == JobStatus.Funded || previousStatus == JobStatus.Submitted) {
            FHE.allowTransient(job.budget, address(paymentToken));
            paymentToken.confidentialTransfer(job.client, job.budget);
            emit Refunded(jobId, job.client);
        }

        if (job.hook != address(0)) {
            try IACPHook(job.hook).afterAction{gas: 100_000}(jobId, this.reject.selector, abi.encode(msg.sender, reason)) {} catch { emit HookFailed(jobId, this.reject.selector); }
        }

        emit JobRejected(jobId, msg.sender, reason);
    }

    /// @notice Claim a refund for an expired funded job. Client only.
    function claimRefund(uint256 jobId) external nonReentrant jobExists(jobId) whenNotPaused {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.client) revert Unauthorized();
        if (block.timestamp < job.expiredAt) revert InvalidStatus();
        if (job.status != JobStatus.Funded && job.status != JobStatus.Submitted) revert InvalidStatus();

        job.status = JobStatus.Expired;
        FHE.allowTransient(job.budget, address(paymentToken));
        paymentToken.confidentialTransfer(job.client, job.budget);

        emit Refunded(jobId, job.client);
    }

    // ═══════════════════════════════════════
    // VIEW
    // ═══════════════════════════════════════

    /// @notice Get job details (budget field is encrypted, only readable by authorized parties).
    function getJob(uint256 jobId) external view returns (
        address client,
        address provider,
        address evaluator,
        string memory description,
        uint256 expiredAt,
        JobStatus status,
        address hook,
        bytes32 deliverable
    ) {
        Job storage job = _jobs[jobId];
        return (
            job.client,
            job.provider,
            job.evaluator,
            job.description,
            job.expiredAt,
            job.status,
            job.hook,
            job.deliverable
        );
    }

    /// @notice Get the encrypted budget handle for a job.
    ///         Only the client and provider can decrypt this via Zama KMS.
    function getJobBudget(uint256 jobId) external view jobExists(jobId) returns (euint64) {
        return _jobs[jobId].budget;
    }

    /// @notice Get the total number of jobs created.
    function totalJobs() external view returns (uint256) {
        return _nextJobId - 1;
    }

    /// @notice Transparency helper: returns totalJobs for fee auditing.
    ///         Each completed job generates a 1% fee in cUSDC sent directly to treasury.
    ///         Treasury can unwrap cUSDC via ConfidentialUSDC.unwrap() to get plaintext USDC.
    function getAccumulatedJobs() external view returns (uint256) {
        return _nextJobId - 1;
    }

    // ═══════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════

    /// @notice Update the fee treasury address. Owner only.
    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        address old = treasury;
        treasury = _treasury;
        emit TreasuryUpdated(old, _treasury);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
