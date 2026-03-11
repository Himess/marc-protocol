// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984Receiver} from "@openzeppelin/confidential-contracts/interfaces/IERC7984Receiver.sol";

/// @title X402PaymentVerifier — On-chain nonce registry for x402 payments
/// @notice Thin contract that records payment nonces for server-side verification.
///         Servers verify ConfidentialTransfer events (from ERC-7984) plus PaymentVerified
///         events (from this contract) to confirm payments.
///         V4.2: Added payAndRecord() for single-TX payment + nonce recording.
///         V4.3: Added recordBatchPayment() for prepaid request bundles.
contract X402PaymentVerifier is ZamaEthereumConfig, IERC7984Receiver {
    /// @notice The trusted ConfidentialUSDC token contract
    address public immutable trustedToken;

    /// @notice Used nonces for replay prevention
    mapping(bytes32 => bool) public usedNonces;

    // ═══════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════

    /// @notice Emitted when a payment nonce is recorded (V4.0)
    event PaymentVerified(address indexed payer, address indexed server, bytes32 indexed nonce, uint64 minPrice);

    /// @notice Emitted when a single-TX payment + nonce is recorded (V4.2)
    event PayAndRecordCompleted(
        address indexed payer,
        address indexed server,
        bytes32 indexed nonce,
        address token,
        uint64 minPrice
    );

    /// @notice Emitted when a batch prepayment nonce is recorded (V4.3)
    event BatchPaymentRecorded(
        address indexed payer,
        address indexed server,
        bytes32 indexed nonce,
        uint32 requestCount,
        uint64 pricePerRequest
    );

    // ═══════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════

    /// @notice Nonce has already been used
    error NonceAlreadyUsed();

    /// @notice Batch request count must be > 0
    error ZeroRequestCount();

    /// @notice Caller is not the trusted token contract
    error UntrustedCaller();

    // ═══════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════

    constructor(address _trustedToken) {
        trustedToken = _trustedToken;
    }

    // ═══════════════════════════════════════
    // V4.0 — SINGLE NONCE RECORDING
    // ═══════════════════════════════════════

    /// @notice Record a payment nonce on-chain for server verification.
    ///         Uses msg.sender as payer to prevent spoofing.
    /// @param server The address that receives the payment
    /// @param nonce Unique payment identifier (bytes32)
    /// @param minPrice Minimum price committed to (6 decimals, e.g. 1000000 = 1 USDC)
    function recordPayment(address server, bytes32 nonce, uint64 minPrice) external {
        if (usedNonces[nonce]) revert NonceAlreadyUsed();
        usedNonces[nonce] = true;
        emit PaymentVerified(msg.sender, server, nonce, minPrice);
    }

    // ═══════════════════════════════════════
    // V4.2 — SINGLE TX (TRANSFER + RECORD)
    // ═══════════════════════════════════════

    /// @notice Combined transfer + nonce recording in a single transaction.
    ///         The caller must have set this contract as an ERC-7984 operator
    ///         on the token via `token.setOperator(verifier, type(uint48).max)`.
    /// @param token The ERC-7984 token contract (e.g. ConfidentialUSDC)
    /// @param server The recipient of the confidential transfer
    /// @param nonce Unique payment identifier (bytes32)
    /// @param minPrice Minimum price committed to (6 decimals)
    /// @param encryptedAmount The FHE-encrypted amount handle
    /// @param inputProof The FHE input proof for the encrypted amount
    function payAndRecord(
        address token,
        address server,
        bytes32 nonce,
        uint64 minPrice,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) external {
        if (usedNonces[nonce]) revert NonceAlreadyUsed();
        usedNonces[nonce] = true;

        // Call confidentialTransferFrom on the ERC-7984 token.
        // Requires msg.sender to have set this contract as operator.
        IERC7984Minimal(token).confidentialTransferFrom(
            msg.sender,
            server,
            encryptedAmount,
            inputProof
        );

        emit PayAndRecordCompleted(msg.sender, server, nonce, token, minPrice);
    }

    // ═══════════════════════════════════════
    // V4.3 — BATCH PREPAYMENT
    // ═══════════════════════════════════════

    /// @notice Record a batch prepayment nonce for multiple future requests.
    ///         The agent makes a single encrypted transfer covering
    ///         (requestCount * pricePerRequest) and records the batch nonce.
    ///         The server tracks remaining credits off-chain.
    ///         Uses msg.sender as payer to prevent spoofing.
    /// @param server The address that receives the payment
    /// @param nonce Unique batch payment identifier (bytes32)
    /// @param requestCount Number of prepaid requests
    /// @param pricePerRequest Price per request in USDC (6 decimals)
    function recordBatchPayment(
        address server,
        bytes32 nonce,
        uint32 requestCount,
        uint64 pricePerRequest
    ) external {
        if (usedNonces[nonce]) revert NonceAlreadyUsed();
        if (requestCount == 0) revert ZeroRequestCount();
        usedNonces[nonce] = true;
        emit BatchPaymentRecorded(msg.sender, server, nonce, requestCount, pricePerRequest);
    }

    // ═══════════════════════════════════════
    // V4.2 — TRANSFER AND CALL CALLBACK
    // ═══════════════════════════════════════

    /// @notice Called by ConfidentialUSDC.confidentialTransferAndCall().
    ///         Decodes nonce + minPrice from data and records the payment.
    ///         This enables single-TX payment + nonce recording.
    ///         Implements IERC7984Receiver (ERC-7984 standard callback).
    /// @param from The payer (original msg.sender of transferAndCall)
    /// @param data ABI-encoded (address server, bytes32 nonce, uint64 minPrice)
    function onConfidentialTransferReceived(
        address /* operator */,
        address from,
        euint64 /* amount */,
        bytes calldata data
    ) external override returns (ebool) {
        if (msg.sender != trustedToken) revert UntrustedCaller();
        (address server, bytes32 nonce, uint64 minPrice) = abi.decode(data, (address, bytes32, uint64));
        if (usedNonces[nonce]) revert NonceAlreadyUsed();
        usedNonces[nonce] = true;
        emit PaymentVerified(from, server, nonce, minPrice);
        return FHE.asEbool(true);
    }
}

/// @notice Minimal ERC-7984 interface for confidentialTransferFrom
interface IERC7984Minimal {
    function confidentialTransferFrom(
        address from,
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) external returns (euint64);
}
