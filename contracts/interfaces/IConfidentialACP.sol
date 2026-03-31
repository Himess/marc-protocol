// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.27;

import {euint64} from "@fhevm/solidity/lib/FHE.sol";

/// @title IConfidentialACP — Interface for FHE-encrypted job escrow
/// @notice Defines the public API for ConfidentialACP. Budget is FHE-encrypted
///         (euint64) and cannot be exposed in a struct via the interface.
interface IConfidentialACP {
    // ═══════════════════════════════════════
    // TYPES
    // ═══════════════════════════════════════

    enum JobStatus { Open, Funded, Submitted, Completed, Rejected, Expired }

    /// @notice Job struct without budget (budget is euint64, not ABI-safe for interfaces).
    struct Job {
        address client;
        address provider;
        address evaluator;
        string description;
        uint256 expiredAt;
        JobStatus status;
        address hook;
        bytes32 deliverable;
    }

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
    // JOB LIFECYCLE
    // ═══════════════════════════════════════

    function createJob(address provider, address evaluator, uint256 expiredAt, string calldata description, address hook) external returns (uint256 jobId);
    function setProvider(uint256 jobId, address provider) external;
    function fund(uint256 jobId, uint64 amount) external;
    function createAndFund(address provider, address evaluator, uint256 expiredAt, string calldata description, address hook, uint64 amount) external returns (uint256 jobId);
    function submit(uint256 jobId, bytes32 deliverable) external;
    function complete(uint256 jobId, bytes32 reason) external;
    function reject(uint256 jobId, bytes32 reason) external;
    function claimRefund(uint256 jobId) external;

    // ═══════════════════════════════════════
    // VIEW
    // ═══════════════════════════════════════

    /// @notice Get job details. Budget is omitted (encrypted). Use getJobBudget() separately.
    function getJob(uint256 jobId) external view returns (
        address client,
        address provider,
        address evaluator,
        string memory description,
        uint256 expiredAt,
        JobStatus status,
        address hook,
        bytes32 deliverable
    );

    /// @notice Get the encrypted budget handle for a job.
    function getJobBudget(uint256 jobId) external view returns (euint64);

    /// @notice Get the total number of jobs created.
    function totalJobs() external view returns (uint256);
}
