// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@fhevm/solidity/lib/FHE.sol";

/// @title IConfidentialPaymentPool — FHE x402 payment pool interface
interface IConfidentialPaymentPool {
    // ═══════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════

    event Deposited(address indexed user, uint64 amount);
    event PaymentExecuted(address indexed from, address indexed to, uint64 minPrice, bytes32 nonce, bytes32 memo);
    event WithdrawRequested(address indexed user, uint256 expiresAt);
    event WithdrawCancelled(address indexed user);
    event WithdrawExpired(address indexed user);
    event WithdrawFinalized(address indexed user, uint64 amount);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event TreasuryWithdrawn(address indexed treasury, uint64 amount);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event BalanceRequested(address indexed user);
    event PoolCapUpdated(uint256 maxPoolBalance, uint256 maxUserDeposit);
    event Paused(address account);
    event Unpaused(address account);

    // ═══════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════

    error ZeroAmount();
    error ZeroAddress();
    error AmountTooSmall();
    error MinPriceTooLow();
    error InvalidRecipient();
    error NonceAlreadyUsed();
    error WithdrawNotRequested();
    error WithdrawAlreadyRequested();
    error WithdrawNotExpired();
    error OnlyOwner();
    error OnlyPendingOwner();
    error PoolCapExceeded();
    error UserCapExceeded();
    error ContractPaused();
    error ContractNotPaused();

    // ═══════════════════════════════════════
    // CORE FUNCTIONS
    // ═══════════════════════════════════════

    /// @notice Deposit plaintext USDC into the pool, converting to encrypted balance
    function deposit(uint64 amount) external;

    /// @notice Pay an agent with encrypted amount, verified against public minPrice
    function pay(
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof,
        uint64 minPrice,
        bytes32 nonce,
        bytes32 memo
    ) external;

    /// @notice Request async decryption of withdraw amount
    function requestWithdraw(
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) external;

    /// @notice Cancel a pending withdrawal and refund to balance
    function cancelWithdraw() external;

    /// @notice Force-cancel an expired withdrawal (callable by anyone after timeout)
    function expireWithdraw(address user) external;

    /// @notice Finalize withdrawal with KMS decryption proof
    function finalizeWithdraw(
        uint64 clearAmount,
        bytes calldata decryptionProof
    ) external;

    /// @notice Request async decryption of balance (snapshot, not live)
    function requestBalance() external;

    // ═══════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════

    /// @notice Pause all pool operations (emergency)
    function pause() external;

    /// @notice Unpause pool operations
    function unpause() external;

    /// @notice Update treasury address
    function setTreasury(address newTreasury) external;

    /// @notice Withdraw accrued fees from treasury's encrypted balance to USDC
    function treasuryWithdraw(uint64 amount) external;

    /// @notice Set pool and per-user deposit caps
    function setPoolCaps(uint256 _maxPoolBalance, uint256 _maxUserDeposit) external;

    /// @notice Start ownership transfer (2-step)
    function transferOwnership(address newOwner) external;

    /// @notice Accept ownership transfer
    function acceptOwnership() external;

    // ═══════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════

    /// @notice Get encrypted balance handle
    function balanceOf(address account) external view returns (euint64);

    /// @notice Get balance snapshot handle (for async decryption)
    function balanceSnapshotOf(address account) external view returns (euint64);

    /// @notice Check if a nonce has been used
    function usedNonces(bytes32 nonce) external view returns (bool);

    /// @notice Check if user has initialized balance
    function isInitialized(address account) external view returns (bool);

    /// @notice Get pending withdraw handle
    function pendingWithdrawOf(address account) external view returns (euint64);

    /// @notice Get withdraw request timestamp
    function withdrawRequestedAt(address account) external view returns (uint256);
}
