// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@fhevm/solidity/lib/FHE.sol";

/// @title IConfidentialPaymentPool — FHE x402 payment pool interface
interface IConfidentialPaymentPool {
    // ═══════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════

    event Deposited(address indexed user, uint64 amount);
    event PaymentExecuted(address indexed from, address indexed to, uint64 minPrice, bytes32 nonce);
    event WithdrawRequested(address indexed user);
    event WithdrawCancelled(address indexed user);
    event WithdrawFinalized(address indexed user, uint64 amount);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

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
    error OnlyOwner();
    error OnlyPendingOwner();

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
        bytes32 nonce
    ) external;

    /// @notice Request async decryption of withdraw amount
    function requestWithdraw(
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) external;

    /// @notice Cancel a pending withdrawal and refund to balance
    function cancelWithdraw() external;

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
}
