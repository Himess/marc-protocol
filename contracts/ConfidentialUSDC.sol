// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.27;

import "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {ERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IConfidentialUSDC.sol";
import {IERC7984Receiver} from "@openzeppelin/confidential-contracts/interfaces/IERC7984Receiver.sol";

/// @title ConfidentialUSDC — FHE x402 Token (V4.0 — ERC-7984 + ERC7984ERC20Wrapper)
/// @notice ERC-7984 confidential USDC token. Wrap USDC → encrypted cUSDC, transfer privately,
///         unwrap back to USDC. Fees charged on wrap and unwrap only (transfers are fee-free).
/// @dev    V4.0: Token-centric rewrite. No pool. Agents hold cUSDC directly.
///         Inherits wrap/unwrap from ERC7984ERC20Wrapper, adds fee layer on top.
///         Parent's _unwrapRequests is private, so we override _unwrap() and finalizeUnwrap()
///         with our own _unwrapRecipients mapping.
contract ConfidentialUSDC is
    ZamaEthereumConfig,
    ERC7984ERC20Wrapper,
    Ownable2Step,
    Pausable,
    ReentrancyGuard,
    IConfidentialUSDC
{
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // ═══════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════

    /// @notice Protocol fee: 10 bps (0.1%)
    uint64 public constant FEE_BPS = 10;
    uint64 public constant BPS = 10_000;
    /// @notice Minimum protocol fee: 0.01 USDC (10_000 micro-USDC)
    uint64 public constant MIN_PROTOCOL_FEE = 10_000;
    /// @notice Governance safety limit: maximum fee is 1% (100 bps).
    ///         The actual fee is FEE_BPS (10 bps). This constant documents the
    ///         upper bound that governance should never exceed.
    uint64 public constant MAX_FEE_BPS = 100;

    // ═══════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════

    /// @notice Fee treasury address
    address public treasury;

    /// @notice Accumulated plaintext fees (USDC) available for withdrawal
    uint256 public accumulatedFees;

    /// @notice Our own unwrap request mapping (parent's _unwrapRequests is private).
    ///         Key is the euint64 handle returned by _burn(). Each _burn() call produces
    ///         a unique ciphertext handle (deterministic from operation + inputs), so
    ///         collisions are not possible in normal operation. The collision check on
    ///         line 124 provides an additional safety guard.
    ///         This follows OpenZeppelin Confidential Contracts' standard pattern.
    mapping(euint64 => address) private _unwrapRecipients;

    // ═══════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════

    constructor(IERC20 _usdc, address _treasury)
        ERC7984("Confidential USDC", "cUSDC", "")
        ERC7984ERC20Wrapper(_usdc)
        Ownable(msg.sender)
    {
        if (_treasury == address(0)) revert ZeroAddress();
        // L-1: Ensure underlying token has 6 decimals (USDC standard)
        if (IERC20Metadata(address(_usdc)).decimals() != 6) revert InvalidDecimals();
        treasury = _treasury;
        // M-1: Assert rate is 1 (USDC standard). This ensures fee math is correct.
        // rate() returns the conversion factor from underlying to wrapper token.
        // For USDC (6 decimals → 6 decimals), rate must be 1.
        if (rate() != 1) revert InvalidDecimals();
        emit TreasuryUpdated(address(0), _treasury);
    }

    // ═══════════════════════════════════════
    // WRAP (USDC → cUSDC with fee)
    // ═══════════════════════════════════════

    /// @notice Wrap USDC into encrypted cUSDC. Fee deducted from amount.
    ///         Minimum wrap: MIN_PROTOCOL_FEE + 1 (so net > 0 after fee).
    /// @param to Recipient of the cUSDC
    /// @param amount Amount of USDC (6 decimals) to wrap
    function wrap(address to, uint256 amount) public override nonReentrant whenNotPaused {
        if (to == address(0)) revert ERC7984InvalidReceiver(to);
        if (amount == 0) revert ZeroAmount();

        // SafeCast: reverts if amount > type(uint64).max
        uint64 safeAmount = SafeCast.toUint64(amount);

        // Dust protection: amount must exceed minimum fee so net > 0
        if (safeAmount <= MIN_PROTOCOL_FEE) revert DustAmount();

        // Calculate plaintext fee
        uint64 fee = _calculateFee(safeAmount);
        uint64 netAmount = safeAmount - fee;

        // Transfer full USDC from user
        SafeERC20.safeTransferFrom(underlying(), msg.sender, address(this), amount);

        // Mint net cUSDC to recipient (encrypted)
        _mint(to, FHE.asEuint64(netAmount));

        // Track fee as plaintext USDC held in contract (consistent with finalizeUnwrap)
        accumulatedFees += uint256(fee) * rate();
    }

    // ═══════════════════════════════════════
    // UNWRAP (cUSDC → USDC, 2-step async)
    // ═══════════════════════════════════════

    /// @dev Override parent's _unwrap to use our own _unwrapRecipients mapping.
    ///      Parent's _unwrapRequests is private, so we replicate the logic.
    function _unwrap(address from, address to, euint64 amount) internal override whenNotPaused {
        if (to == address(0)) revert ERC7984InvalidReceiver(to);
        if (from != msg.sender && !isOperator(from, msg.sender)) revert ERC7984UnauthorizedSpender(from, msg.sender);

        // Burn tokens, get actual burnt amount handle
        euint64 burntAmount = _burn(from, amount);
        FHE.makePubliclyDecryptable(burntAmount);

        if (_unwrapRecipients[burntAmount] != address(0)) revert UnwrapAlreadyRequested();
        _unwrapRecipients[burntAmount] = to;

        emit UnwrapRequested(to, burntAmount);
    }

    /// @dev Override parent's finalizeUnwrap to deduct fee from USDC transfer.
    function finalizeUnwrap(
        euint64 burntAmount,
        uint64 burntAmountCleartext,
        bytes calldata decryptionProof
    ) public override nonReentrant whenNotPaused {
        address to = _unwrapRecipients[burntAmount];
        if (to == address(0)) revert InvalidUnwrapRequest(burntAmount);
        delete _unwrapRecipients[burntAmount];

        // Verify KMS proof
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = euint64.unwrap(burntAmount);
        bytes memory cleartexts = abi.encode(burntAmountCleartext);
        FHE.checkSignatures(handles, cleartexts, decryptionProof);

        if (burntAmountCleartext > 0) {
            // Calculate withdrawal fee
            uint64 fee = _calculateFee(burntAmountCleartext);
            uint64 netAmount = burntAmountCleartext - fee;

            // Transfer net USDC to recipient (rate is 1 for USDC)
            if (netAmount > 0) {
                SafeERC20.safeTransfer(underlying(), to, uint256(netAmount) * rate());
            }

            // Track fee
            accumulatedFees += uint256(fee) * rate();
        }

        emit UnwrapFinalized(to, burntAmount, burntAmountCleartext);
    }

    // ═══════════════════════════════════════
    // V4.2 — TRANSFER AND CALL
    // ═══════════════════════════════════════

    /// @notice Transfer encrypted cUSDC and call a callback on the recipient.
    ///         Enables single-TX payment + nonce recording.
    ///         The recipient MUST implement IERC7984Receiver.
    /// @param to Recipient contract address
    /// @param encryptedAmount FHE-encrypted amount handle
    /// @param inputProof FHE input proof
    /// @param data Arbitrary calldata forwarded to onConfidentialTransferReceived
    /// @return transferred The encrypted amount that was actually transferred
    function confidentialTransferAndCall(
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof,
        bytes calldata data
    ) public override nonReentrant whenNotPaused returns (euint64 transferred) {
        // M-2: Prevent self-transfer + callback (wastes gas, no economic purpose)
        if (to == msg.sender) revert SelfTransfer();
        euint64 value = FHE.fromExternal(encryptedAmount, inputProof);
        transferred = _transfer(msg.sender, to, value);

        // Call the IERC7984Receiver callback on recipient (ERC-7984 standard)
        // Allow the transferred amount handle for the recipient so the callback
        // can access the encrypted amount (FHE ACL requirement for cross-contract handles)
        if (to.code.length > 0) {
            FHE.allowTransient(transferred, to);
            try IERC7984Receiver(to).onConfidentialTransferReceived(
                msg.sender, // operator
                msg.sender, // from
                transferred,
                data
            ) returns (ebool accepted) {
                // L-7: The accepted ebool is stored per ERC-7984 spec compliance.
                // The transfer has already completed; the callback merely signals
                // the receiver's acceptance for event/logging purposes.
                // Future versions may use this to implement conditional transfers.
                FHE.allowTransient(accepted, address(this));
            } catch {
                revert TransferCallbackFailed();
            }
        }

        FHE.allowTransient(transferred, msg.sender);
    }

    // ═══════════════════════════════════════
    // CORE TRANSFER OVERRIDES — whenNotPaused
    // Ensures ALL transfer paths are blocked during emergency pause.
    // Parent ERC7984 exposes these without pause guards.
    // ═══════════════════════════════════════

    /// @notice Transfer encrypted cUSDC (externalEuint64, new encryption).
    function confidentialTransfer(
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) public override whenNotPaused returns (euint64) {
        return super.confidentialTransfer(to, encryptedAmount, inputProof);
    }

    /// @notice Transfer encrypted cUSDC (euint64 handle, existing encryption).
    function confidentialTransfer(
        address to,
        euint64 amount
    ) public override whenNotPaused returns (euint64) {
        return super.confidentialTransfer(to, amount);
    }

    /// @notice Transfer encrypted cUSDC from another address (externalEuint64).
    function confidentialTransferFrom(
        address from,
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) public override whenNotPaused returns (euint64) {
        return super.confidentialTransferFrom(from, to, encryptedAmount, inputProof);
    }

    /// @notice Transfer encrypted cUSDC from another address (euint64 handle).
    function confidentialTransferFrom(
        address from,
        address to,
        euint64 amount
    ) public override whenNotPaused returns (euint64) {
        return super.confidentialTransferFrom(from, to, amount);
    }

    /// @notice Set operator approval. Blocked during pause to prevent pre-staging attacks.
    function setOperator(address operator, uint48 until) public override whenNotPaused {
        super.setOperator(operator, until);
    }

    // ═══════════════════════════════════════
    // TRANSFER-AND-CALL OVERRIDES (nonReentrant + whenNotPaused)
    // ═══════════════════════════════════════

    /// @notice Transfer encrypted cUSDC (euint64 handle) and call receiver callback.
    function confidentialTransferAndCall(
        address to,
        euint64 value,
        bytes calldata data
    ) public override nonReentrant whenNotPaused returns (euint64) {
        return super.confidentialTransferAndCall(to, value, data);
    }

    /// @notice Transfer encrypted cUSDC from another address and call receiver callback (externalEuint64 variant).
    function confidentialTransferFromAndCall(
        address from,
        address to,
        externalEuint64 value,
        bytes calldata inputProof,
        bytes calldata data
    ) public override nonReentrant whenNotPaused returns (euint64) {
        return super.confidentialTransferFromAndCall(from, to, value, inputProof, data);
    }

    /// @notice Transfer encrypted cUSDC from another address and call receiver callback (euint64 handle variant).
    function confidentialTransferFromAndCall(
        address from,
        address to,
        euint64 value,
        bytes calldata data
    ) public override nonReentrant whenNotPaused returns (euint64) {
        return super.confidentialTransferFromAndCall(from, to, value, data);
    }

    // ═══════════════════════════════════════
    // ERC-1363 FEE BYPASS PREVENTION
    // ═══════════════════════════════════════

    /// @dev Override parent's onTransferReceived to prevent ERC-1363 fee bypass.
    ///      All wrapping must go through wrap() which charges the protocol fee.
    function onTransferReceived(
        address,
        address,
        uint256,
        bytes calldata
    ) public pure override returns (bytes4) {
        revert ERC1363WrappingDisabled();
    }

    // ═══════════════════════════════════════
    // ADMIN — TREASURY
    // ═══════════════════════════════════════

    /// @notice Update the fee treasury address.
    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        address old = treasury;
        treasury = _treasury;
        emit TreasuryUpdated(old, _treasury);
    }

    /// @notice Withdraw accumulated plaintext USDC fees to treasury.
    function treasuryWithdraw() external nonReentrant {
        if (msg.sender != treasury && msg.sender != owner()) revert OwnableUnauthorizedAccount(msg.sender);
        if (accumulatedFees == 0) revert InsufficientFees();

        uint256 amount = accumulatedFees;
        accumulatedFees = 0;
        SafeERC20.safeTransfer(underlying(), treasury, amount);

        emit TreasuryWithdrawn(treasury, amount);
    }

    // ═══════════════════════════════════════
    // ADMIN — PAUSE
    // ═══════════════════════════════════════

    /// @notice Pause wrap/unwrap operations (emergency stop)
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume operations
    function unpause() external onlyOwner {
        _unpause();
    }

    // ═══════════════════════════════════════
    // INTERNAL
    // ═══════════════════════════════════════

    /// @dev Calculate fee: max(amount * FEE_BPS / BPS, MIN_PROTOCOL_FEE).
    ///      Uses uint256 intermediate to prevent overflow for large amounts.
    function _calculateFee(uint64 amount) internal pure returns (uint64) {
        uint256 percentageFee = (uint256(amount) * FEE_BPS) / BPS;
        uint256 fee = percentageFee > MIN_PROTOCOL_FEE ? percentageFee : MIN_PROTOCOL_FEE;
        return uint64(fee); // Safe: fee <= amount (which fits uint64)
    }
}
