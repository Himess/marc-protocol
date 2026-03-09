// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IConfidentialPaymentPool.sol";

/// @title ConfidentialPaymentPool — FHE x402 Payment Pool (V1.2)
/// @notice All-in-one pool for the fhe-confidential-v1 x402 scheme.
///         Deposit plaintext USDC → encrypted balance → encrypted pay → 2-step withdraw.
///         Silent failure pattern: insufficient funds → 0 transfer (no revert = no info leak).
/// @dev    V1.2 additions: Pausable, treasury withdraw, withdraw timeout (7 days),
///         TVL/user caps, payment memo, gas optimizations.
contract ConfidentialPaymentPool is ZamaEthereumConfig, IConfidentialPaymentPool, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════

    /// @notice Protocol fee: 10 bps (0.1%)
    uint64 public constant FEE_BPS = 10;
    uint64 public constant BPS = 10_000;
    /// @notice Minimum protocol fee: 0.01 USDC (10_000 micro-USDC)
    uint64 public constant MIN_PROTOCOL_FEE = 10_000;
    /// @notice Withdraw requests expire after 7 days
    uint256 public constant WITHDRAW_TIMEOUT = 7 days;

    // ═══════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════

    /// @notice The USDC token contract
    IERC20 public immutable usdc;

    /// @notice Pool owner (can pause, update treasury, transfer ownership)
    address public owner;

    /// @notice Pending owner for 2-step transfer
    address public pendingOwner;

    /// @notice Fee treasury address
    address public treasury;

    /// @notice Whether pool is paused
    bool public paused;

    /// @notice Maximum total USDC in pool (0 = unlimited)
    uint256 public maxPoolBalance;

    /// @notice Maximum per-user cumulative deposit (0 = unlimited)
    uint256 public maxUserDeposit;

    /// @notice Encrypted balances
    mapping(address => euint64) private _balances;

    /// @notice Whether a user has an initialized encrypted balance
    mapping(address => bool) private _initialized;

    /// @notice Used nonces for replay prevention
    mapping(bytes32 => bool) public usedNonces;

    /// @notice Whether a user has a pending withdraw request
    mapping(address => bool) public withdrawRequested;

    /// @notice Pending withdraw encrypted amount handle (for KMS decryption)
    mapping(address => euint64) private _pendingWithdraw;

    /// @notice Timestamp when withdraw was requested (for timeout)
    mapping(address => uint256) public withdrawRequestedAt;

    /// @notice Balance snapshot for async decryption (does not expose live handle)
    mapping(address => euint64) private _balanceSnapshot;

    /// @notice Whether a user has a pending balance query
    mapping(address => bool) public balanceQueryRequested;

    /// @notice Cumulative deposits per user (for per-user cap enforcement)
    mapping(address => uint256) public totalDeposited;

    // ═══════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════

    constructor(address _usdc, address _treasury) {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        owner = msg.sender;
        treasury = _treasury;
    }

    // ═══════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier whenPaused() {
        if (!paused) revert ContractNotPaused();
        _;
    }

    // ═══════════════════════════════════════
    // DEPOSIT
    // ═══════════════════════════════════════

    /// @notice Deposit plaintext USDC → encrypted pool balance.
    ///         Fee is calculated from the plaintext deposit amount.
    ///         Minimum deposit: MIN_PROTOCOL_FEE (0.01 USDC)
    function deposit(uint64 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (amount < MIN_PROTOCOL_FEE) revert AmountTooSmall();

        // Enforce pool TVL cap
        if (maxPoolBalance > 0) {
            uint256 poolBal = usdc.balanceOf(address(this));
            if (poolBal + uint256(amount) > maxPoolBalance) revert PoolCapExceeded();
        }

        // Enforce per-user deposit cap
        if (maxUserDeposit > 0) {
            if (totalDeposited[msg.sender] + uint256(amount) > maxUserDeposit) revert UserCapExceeded();
        }
        totalDeposited[msg.sender] += uint256(amount);

        // Calculate deposit fee from plaintext amount
        uint64 fee = _calculateFee(amount);
        uint64 netAmount = amount - fee;

        // Transfer USDC from user
        usdc.safeTransferFrom(msg.sender, address(this), uint256(amount));

        // Credit net amount to user's encrypted balance
        euint64 encNet = FHE.asEuint64(netAmount);
        if (!_initialized[msg.sender]) {
            _balances[msg.sender] = encNet;
            _initialized[msg.sender] = true;
        } else {
            _balances[msg.sender] = FHE.add(_balances[msg.sender], encNet);
        }
        FHE.allowThis(_balances[msg.sender]);
        FHE.allow(_balances[msg.sender], msg.sender);

        // Credit fee to treasury
        if (fee > 0) {
            _creditTreasury(fee);
        }

        emit Deposited(msg.sender, amount);
    }

    // ═══════════════════════════════════════
    // PAY (encrypted agent-to-agent payment)
    // ═══════════════════════════════════════

    /// @notice Pay an agent. The encrypted amount is checked against minPrice.
    ///         Silent failure: if balance < encrypted amount, transfers 0.
    ///         Fee is calculated from the public minPrice (no FHE.div needed).
    /// @param memo Optional 32-byte payment reference (invoice ID, order hash, etc.)
    /// @dev    PaymentExecuted emits even on silent failure (0-transfer).
    ///         This is inherent to FHE — we cannot branch on encrypted booleans.
    ///         minPrice must be >= MIN_PROTOCOL_FEE to prevent FHE underflow.
    function pay(
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof,
        uint64 minPrice,
        bytes32 nonce,
        bytes32 memo
    ) external nonReentrant whenNotPaused {
        if (to == address(0)) revert ZeroAddress();
        if (to == treasury) revert InvalidRecipient();
        if (minPrice < MIN_PROTOCOL_FEE) revert MinPriceTooLow();
        if (usedNonces[nonce]) revert NonceAlreadyUsed();
        usedNonces[nonce] = true;

        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);

        // Check: encrypted amount >= minPrice (public check)
        ebool meetsPrice = FHE.ge(amount, FHE.asEuint64(minPrice));

        // Check: sender has sufficient balance
        ebool hasFunds;
        if (_initialized[msg.sender]) {
            hasFunds = FHE.le(amount, _balances[msg.sender]);
        } else {
            hasFunds = FHE.asEbool(false);
        }

        // Both conditions must be true
        ebool canPay = FHE.and(meetsPrice, hasFunds);

        // Silent failure: transfer 0 if conditions not met
        euint64 transferAmount = FHE.select(canPay, amount, FHE.asEuint64(0));

        // Calculate fee from public minPrice (safe: minPrice >= MIN_PROTOCOL_FEE)
        uint64 fee = _calculateFee(minPrice);
        euint64 encFee = FHE.select(canPay, FHE.asEuint64(fee), FHE.asEuint64(0));
        euint64 netTransfer = FHE.sub(transferAmount, encFee);

        // Deduct from sender
        if (_initialized[msg.sender]) {
            _balances[msg.sender] = FHE.sub(_balances[msg.sender], transferAmount);
            FHE.allowThis(_balances[msg.sender]);
            FHE.allow(_balances[msg.sender], msg.sender);
        }

        // Credit to recipient
        if (!_initialized[to]) {
            _balances[to] = netTransfer;
            _initialized[to] = true;
        } else {
            _balances[to] = FHE.add(_balances[to], netTransfer);
        }
        FHE.allowThis(_balances[to]);
        FHE.allow(_balances[to], to);

        // Credit fee to treasury
        if (!_initialized[treasury]) {
            _balances[treasury] = encFee;
            _initialized[treasury] = true;
        } else {
            _balances[treasury] = FHE.add(_balances[treasury], encFee);
        }
        FHE.allowThis(_balances[treasury]);
        FHE.allow(_balances[treasury], treasury);

        emit PaymentExecuted(msg.sender, to, minPrice, nonce, memo);
    }

    // ═══════════════════════════════════════
    // WITHDRAW (2-step async decryption)
    // ═══════════════════════════════════════

    /// @notice Step 1: Request withdrawal. Marks encrypted amount as publicly decryptable.
    ///         Expires after WITHDRAW_TIMEOUT (7 days).
    function requestWithdraw(
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) external nonReentrant whenNotPaused {
        if (withdrawRequested[msg.sender]) revert WithdrawAlreadyRequested();

        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);

        // Check sufficient balance (silent cap to 0 if not enough)
        ebool hasFunds;
        if (_initialized[msg.sender]) {
            hasFunds = FHE.le(amount, _balances[msg.sender]);
        } else {
            hasFunds = FHE.asEbool(false);
        }
        euint64 withdrawAmount = FHE.select(hasFunds, amount, FHE.asEuint64(0));

        // Deduct from balance immediately (prevents double-spend)
        if (_initialized[msg.sender]) {
            _balances[msg.sender] = FHE.sub(_balances[msg.sender], withdrawAmount);
            FHE.allowThis(_balances[msg.sender]);
            FHE.allow(_balances[msg.sender], msg.sender);
        }

        // Store pending withdraw and make publicly decryptable
        _pendingWithdraw[msg.sender] = withdrawAmount;
        FHE.allowThis(_pendingWithdraw[msg.sender]);
        FHE.makePubliclyDecryptable(_pendingWithdraw[msg.sender]);

        withdrawRequested[msg.sender] = true;
        withdrawRequestedAt[msg.sender] = block.timestamp;

        uint256 expiresAt = block.timestamp + WITHDRAW_TIMEOUT;
        emit WithdrawRequested(msg.sender, expiresAt);
    }

    /// @notice Cancel a pending withdrawal and refund the pending amount to balance.
    ///         Use this if requestWithdraw silently failed (0 pending) or to change amount.
    function cancelWithdraw() external nonReentrant {
        if (!withdrawRequested[msg.sender]) revert WithdrawNotRequested();

        // Refund pending amount back to balance (if 0, this is a no-op add)
        if (_initialized[msg.sender]) {
            _balances[msg.sender] = FHE.add(_balances[msg.sender], _pendingWithdraw[msg.sender]);
            FHE.allowThis(_balances[msg.sender]);
            FHE.allow(_balances[msg.sender], msg.sender);
        }

        // Clear pending state
        _pendingWithdraw[msg.sender] = FHE.asEuint64(0);
        withdrawRequested[msg.sender] = false;
        withdrawRequestedAt[msg.sender] = 0;

        emit WithdrawCancelled(msg.sender);
    }

    /// @notice Force-cancel an expired withdrawal and refund to user.
    ///         Callable by anyone after WITHDRAW_TIMEOUT has passed.
    function expireWithdraw(address user) external nonReentrant {
        if (!withdrawRequested[user]) revert WithdrawNotRequested();
        if (block.timestamp < withdrawRequestedAt[user] + WITHDRAW_TIMEOUT) revert WithdrawNotExpired();

        // Refund pending amount back to user's balance
        if (_initialized[user]) {
            _balances[user] = FHE.add(_balances[user], _pendingWithdraw[user]);
            FHE.allowThis(_balances[user]);
            FHE.allow(_balances[user], user);
        }

        // Clear pending state
        _pendingWithdraw[user] = FHE.asEuint64(0);
        withdrawRequested[user] = false;
        withdrawRequestedAt[user] = 0;

        emit WithdrawExpired(user);
    }

    /// @notice Step 2: Finalize withdrawal with KMS decryption proof.
    function finalizeWithdraw(
        uint64 clearAmount,
        bytes calldata decryptionProof
    ) external nonReentrant {
        if (!withdrawRequested[msg.sender]) revert WithdrawNotRequested();

        // Verify KMS proof
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = FHE.toBytes32(_pendingWithdraw[msg.sender]);
        bytes memory abiClearValue = abi.encode(clearAmount);
        FHE.checkSignatures(handles, abiClearValue, decryptionProof);

        // Reset state
        withdrawRequested[msg.sender] = false;
        withdrawRequestedAt[msg.sender] = 0;
        _pendingWithdraw[msg.sender] = FHE.asEuint64(0);

        if (clearAmount > 0) {
            // Calculate withdrawal fee
            uint64 fee = _calculateFee(clearAmount);
            uint64 netAmount = clearAmount - fee;

            // Transfer net USDC to user
            if (netAmount > 0) {
                usdc.safeTransfer(msg.sender, uint256(netAmount));
            }

            // Credit fee to treasury's encrypted balance
            if (fee > 0) {
                _creditTreasury(fee);
            }
        }

        emit WithdrawFinalized(msg.sender, clearAmount);
    }

    // ═══════════════════════════════════════
    // BALANCE QUERY (async decryption)
    // ═══════════════════════════════════════

    /// @notice Request async decryption of your encrypted balance.
    ///         Creates a snapshot — does NOT expose the live balance handle.
    ///         Future deposits/payments do not affect the snapshot.
    function requestBalance() external {
        if (!_initialized[msg.sender]) {
            return;
        }
        // Create snapshot: FHE.add(x, 0) produces a new handle with same value
        _balanceSnapshot[msg.sender] = FHE.add(_balances[msg.sender], FHE.asEuint64(0));
        FHE.allowThis(_balanceSnapshot[msg.sender]);
        FHE.makePubliclyDecryptable(_balanceSnapshot[msg.sender]);
        balanceQueryRequested[msg.sender] = true;

        emit BalanceRequested(msg.sender);
    }

    // ═══════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════

    /// @notice Get encrypted balance handle (only the user can decrypt via view key)
    function balanceOf(address account) external view returns (euint64) {
        return _balances[account];
    }

    /// @notice Get balance snapshot handle (for async decryption results)
    function balanceSnapshotOf(address account) external view returns (euint64) {
        return _balanceSnapshot[account];
    }

    /// @notice Check if an account has an initialized balance
    function isInitialized(address account) external view returns (bool) {
        return _initialized[account];
    }

    /// @notice Get pending withdraw handle
    function pendingWithdrawOf(address account) external view returns (euint64) {
        return _pendingWithdraw[account];
    }

    // ═══════════════════════════════════════
    // ADMIN — PAUSE
    // ═══════════════════════════════════════

    /// @notice Pause all pool operations (emergency stop)
    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice Resume pool operations
    function unpause() external onlyOwner whenPaused {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ═══════════════════════════════════════
    // ADMIN — TREASURY
    // ═══════════════════════════════════════

    /// @notice Update the fee treasury address.
    ///         Migrates accrued encrypted fees to the new treasury.
    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        address old = treasury;

        // Migrate accrued fees to new treasury
        if (_initialized[old]) {
            if (!_initialized[_treasury]) {
                _balances[_treasury] = _balances[old];
                _initialized[_treasury] = true;
            } else {
                _balances[_treasury] = FHE.add(_balances[_treasury], _balances[old]);
            }
            FHE.allowThis(_balances[_treasury]);
            FHE.allow(_balances[_treasury], _treasury);

            // Zero out old treasury balance
            _balances[old] = FHE.asEuint64(0);
            FHE.allowThis(_balances[old]);
            FHE.allow(_balances[old], old);
        }

        treasury = _treasury;
        emit TreasuryUpdated(old, _treasury);
    }

    /// @notice Withdraw accrued fees from treasury's encrypted balance.
    ///         Only callable by current treasury address or owner.
    ///         Deducts plaintext amount from treasury's encrypted balance.
    function treasuryWithdraw(uint64 amount) external nonReentrant {
        if (msg.sender != treasury && msg.sender != owner) revert OnlyOwner();
        if (amount == 0) revert ZeroAmount();

        if (!_initialized[treasury]) revert ZeroAmount();

        // Deduct from treasury's encrypted balance
        // Note: if amount > balance, FHE.sub underflows silently (becomes huge number)
        // so caller must ensure amount <= actual balance via off-chain check
        euint64 encAmount = FHE.asEuint64(amount);
        _balances[treasury] = FHE.sub(_balances[treasury], encAmount);
        FHE.allowThis(_balances[treasury]);
        FHE.allow(_balances[treasury], treasury);

        // Transfer USDC to treasury address
        usdc.safeTransfer(treasury, uint256(amount));

        emit TreasuryWithdrawn(treasury, amount);
    }

    // ═══════════════════════════════════════
    // ADMIN — POOL CAPS
    // ═══════════════════════════════════════

    /// @notice Set pool TVL cap and per-user deposit cap.
    ///         Set to 0 to disable a cap.
    function setPoolCaps(uint256 _maxPoolBalance, uint256 _maxUserDeposit) external onlyOwner {
        maxPoolBalance = _maxPoolBalance;
        maxUserDeposit = _maxUserDeposit;
        emit PoolCapUpdated(_maxPoolBalance, _maxUserDeposit);
    }

    // ═══════════════════════════════════════
    // ADMIN — OWNERSHIP
    // ═══════════════════════════════════════

    /// @notice Start 2-step ownership transfer
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Accept ownership transfer (must be called by pendingOwner)
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert OnlyPendingOwner();
        address old = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(old, owner);
    }

    // ═══════════════════════════════════════
    // INTERNAL
    // ═══════════════════════════════════════

    /// @dev Calculate fee: max(amount * FEE_BPS / BPS, MIN_PROTOCOL_FEE)
    ///      Uses plaintext arithmetic (no FHE.div needed)
    function _calculateFee(uint64 amount) internal pure returns (uint64) {
        uint64 percentageFee = (amount * FEE_BPS) / BPS;
        return percentageFee > MIN_PROTOCOL_FEE ? percentageFee : MIN_PROTOCOL_FEE;
    }

    /// @dev Credit fee to treasury's encrypted balance
    function _creditTreasury(uint64 fee) internal {
        euint64 encFee = FHE.asEuint64(fee);
        if (!_initialized[treasury]) {
            _balances[treasury] = encFee;
            _initialized[treasury] = true;
        } else {
            _balances[treasury] = FHE.add(_balances[treasury], encFee);
        }
        FHE.allowThis(_balances[treasury]);
        FHE.allow(_balances[treasury], treasury);
    }
}
