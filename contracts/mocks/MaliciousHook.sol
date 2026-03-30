// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import "../interfaces/IACP.sol";

/// @title MaliciousHook — Always reverts on afterAction (for testing try/catch)
contract MaliciousHook is IACPHook {
    function afterAction(uint256, bytes4, bytes calldata) external pure override {
        revert("MALICIOUS_HOOK_REVERT");
    }
}
