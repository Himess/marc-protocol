// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.27;

/// @title IConfidentialUSDC — ConfidentialUSDC token interface (V4.0)
/// @notice ERC-7984 + ERC7984ERC20Wrapper base functions (name, symbol, decimals,
///         confidentialBalanceOf, confidentialTransfer, setOperator, isOperator,
///         wrap, unwrap, finalizeUnwrap) are inherited.
///         This interface only defines fee + admin extensions.
interface IConfidentialUSDC {
    // ═══════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════

    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event TreasuryWithdrawn(address indexed treasury, uint256 amount);

    // ═══════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════

    error ZeroAddress();
    error ZeroAmount();
    error DustAmount();
    error InvalidDecimals();
    error InsufficientFees();
    error UnwrapAlreadyRequested();
    error TransferCallbackFailed();
    error SelfTransfer();
    // NOTE: InvalidUnwrapRequest(euint64) is inherited from ERC7984ERC20Wrapper

    // ═══════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════

    /// @notice Update treasury address
    function setTreasury(address newTreasury) external;

    /// @notice Withdraw accumulated plaintext USDC fees to treasury
    function treasuryWithdraw() external;

    // ═══════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════

    /// @notice Fee treasury address
    function treasury() external view returns (address);

    /// @notice Accumulated plaintext fees available for withdrawal
    function accumulatedFees() external view returns (uint256);
}
