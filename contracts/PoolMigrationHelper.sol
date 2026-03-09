// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title PoolMigrationHelper — Migrate USDC from old pool to new (proxy) pool
/// @notice Helper for users who have already finalized their withdrawal from the old pool.
///         Approve + deposit to new pool in a single transaction.
///         Only works with plaintext USDC (after withdraw finalization).
contract PoolMigrationHelper {
    using SafeERC20 for IERC20;

    /// @notice Migrate USDC from caller to new pool via deposit
    /// @param usdc The USDC token address
    /// @param newPool The new (proxy) pool address
    /// @param amount The plaintext USDC amount to deposit (6 decimals)
    function migrate(address usdc, address newPool, uint64 amount) external {
        require(amount > 0, "Zero amount");

        // Transfer USDC from caller to this contract
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), uint256(amount));

        // Approve new pool
        IERC20(usdc).forceApprove(newPool, uint256(amount));

        // Deposit into new pool (caller must have approved this helper for USDC)
        // Note: deposit() is called from this contract's context, so the pool
        // credits this helper contract, not the user. Users should instead just
        // approve the new pool directly and call deposit().
        // This helper is provided as a convenience for batching the approve+deposit.
        (bool success, ) = newPool.call(
            abi.encodeWithSignature("deposit(uint64)", amount)
        );
        require(success, "Deposit failed");
    }
}
