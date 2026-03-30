// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

contract MockX402Verifier {
    mapping(bytes32 => bool) public usedNonces;

    function registerNonce(bytes32 nonce) external {
        usedNonces[nonce] = true;
    }
}
