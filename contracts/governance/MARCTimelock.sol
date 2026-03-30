// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.27;

import "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title MARCTimelock — Governance timelock for MARC Protocol
/// @notice Wraps OpenZeppelin TimelockController with a minimum 48-hour delay.
///         Used as the owner of ConfidentialUSDC and AgenticCommerceProtocol
///         to prevent instant treasury changes or parameter updates.
/// @dev    The Gnosis Safe multisig is set as both proposer and executor.
///         The deployer EOA should NOT be an admin after setup.
contract MARCTimelock is TimelockController {
    /// @param minDelay Minimum delay in seconds (recommend 48 hours = 172800)
    /// @param proposers Addresses that can propose operations (Gnosis Safe)
    /// @param executors Addresses that can execute operations (Gnosis Safe)
    /// @param admin Optional admin address (set to address(0) to renounce)
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {
        require(minDelay >= 1 hours && minDelay <= 365 days, "MARCTimelock: invalid delay");
        require(proposers.length > 0, "MARCTimelock: no proposers");
        require(executors.length > 0, "MARCTimelock: no executors");
    }
}
