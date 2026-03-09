// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@fhevm/solidity/lib/FHE.sol";
import {ZamaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IConfidentialPaymentPool.sol";

/// @title ConfidentialPaymentPoolUpgradeable — UUPS-upgradeable FHE x402 Payment Pool
/// @notice Same logic as ConfidentialPaymentPool V1.2, but uses UUPS proxy pattern.
///         Does NOT inherit ZamaEthereumConfig — calls FHE.setCoprocessor() in initialize().
contract ConfidentialPaymentPoolUpgradeable is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuard,
    IConfidentialPaymentPool
{
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════

    uint64 public constant FEE_BPS = 10;
    uint64 public constant BPS = 10_000;
    uint64 public constant MIN_PROTOCOL_FEE = 10_000;
    uint256 public constant WITHDRAW_TIMEOUT = 7 days;

    // ═══════════════════════════════════════
    // STATE (same layout as V1.2, but usdc is not immutable)
    // ═══════════════════════════════════════

    /// @notice The USDC token contract (not immutable — proxies can't use immutables)
    IERC20 public usdc;

    address public owner;
    address public pendingOwner;
    address public treasury;
    bool public paused;
    uint256 public maxPoolBalance;
    uint256 public maxUserDeposit;

    mapping(address => euint64) private _balances;
    mapping(address => bool) private _balanceInitialized;
    mapping(bytes32 => bool) public usedNonces;
    mapping(address => bool) public withdrawRequested;
    mapping(address => euint64) private _pendingWithdraw;
    mapping(address => uint256) public withdrawRequestedAt;
    mapping(address => euint64) private _balanceSnapshot;
    mapping(address => bool) public balanceQueryRequested;
    mapping(address => uint256) public totalDeposited;

    /// @dev Reserved storage gap for future upgrades
    uint256[50] private __gap;

    // ═══════════════════════════════════════
    // INITIALIZER (replaces constructor)
    // ═══════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _usdc, address _treasury) external initializer {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();

        // Initialize FHE coprocessor (replaces ZamaEthereumConfig constructor)
        FHE.setCoprocessor(ZamaConfig.getEthereumCoprocessorConfig());

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
    // UUPS
    // ═══════════════════════════════════════

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ═══════════════════════════════════════
    // DEPOSIT
    // ═══════════════════════════════════════

    function deposit(uint64 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (amount < MIN_PROTOCOL_FEE) revert AmountTooSmall();

        if (maxPoolBalance > 0) {
            uint256 poolBal = usdc.balanceOf(address(this));
            if (poolBal + uint256(amount) > maxPoolBalance) revert PoolCapExceeded();
        }

        if (maxUserDeposit > 0) {
            if (totalDeposited[msg.sender] + uint256(amount) > maxUserDeposit) revert UserCapExceeded();
        }
        totalDeposited[msg.sender] += uint256(amount);

        uint64 fee = _calculateFee(amount);
        uint64 netAmount = amount - fee;

        usdc.safeTransferFrom(msg.sender, address(this), uint256(amount));

        euint64 encNet = FHE.asEuint64(netAmount);
        if (!_balanceInitialized[msg.sender]) {
            _balances[msg.sender] = encNet;
            _balanceInitialized[msg.sender] = true;
        } else {
            _balances[msg.sender] = FHE.add(_balances[msg.sender], encNet);
        }
        FHE.allowThis(_balances[msg.sender]);
        FHE.allow(_balances[msg.sender], msg.sender);

        if (fee > 0) {
            _creditTreasury(fee);
        }

        emit Deposited(msg.sender, amount);
    }

    // ═══════════════════════════════════════
    // PAY
    // ═══════════════════════════════════════

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

        ebool meetsPrice = FHE.ge(amount, FHE.asEuint64(minPrice));

        ebool hasFunds;
        if (_balanceInitialized[msg.sender]) {
            hasFunds = FHE.le(amount, _balances[msg.sender]);
        } else {
            hasFunds = FHE.asEbool(false);
        }

        ebool canPay = FHE.and(meetsPrice, hasFunds);
        euint64 transferAmount = FHE.select(canPay, amount, FHE.asEuint64(0));

        uint64 fee = _calculateFee(minPrice);
        euint64 encFee = FHE.select(canPay, FHE.asEuint64(fee), FHE.asEuint64(0));
        euint64 netTransfer = FHE.sub(transferAmount, encFee);

        if (_balanceInitialized[msg.sender]) {
            _balances[msg.sender] = FHE.sub(_balances[msg.sender], transferAmount);
            FHE.allowThis(_balances[msg.sender]);
            FHE.allow(_balances[msg.sender], msg.sender);
        }

        if (!_balanceInitialized[to]) {
            _balances[to] = netTransfer;
            _balanceInitialized[to] = true;
        } else {
            _balances[to] = FHE.add(_balances[to], netTransfer);
        }
        FHE.allowThis(_balances[to]);
        FHE.allow(_balances[to], to);

        if (!_balanceInitialized[treasury]) {
            _balances[treasury] = encFee;
            _balanceInitialized[treasury] = true;
        } else {
            _balances[treasury] = FHE.add(_balances[treasury], encFee);
        }
        FHE.allowThis(_balances[treasury]);
        FHE.allow(_balances[treasury], treasury);

        emit PaymentExecuted(msg.sender, to, minPrice, nonce, memo);
    }

    // ═══════════════════════════════════════
    // WITHDRAW
    // ═══════════════════════════════════════

    function requestWithdraw(
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) external nonReentrant whenNotPaused {
        if (withdrawRequested[msg.sender]) revert WithdrawAlreadyRequested();

        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);

        ebool hasFunds;
        if (_balanceInitialized[msg.sender]) {
            hasFunds = FHE.le(amount, _balances[msg.sender]);
        } else {
            hasFunds = FHE.asEbool(false);
        }
        euint64 withdrawAmount = FHE.select(hasFunds, amount, FHE.asEuint64(0));

        if (_balanceInitialized[msg.sender]) {
            _balances[msg.sender] = FHE.sub(_balances[msg.sender], withdrawAmount);
            FHE.allowThis(_balances[msg.sender]);
            FHE.allow(_balances[msg.sender], msg.sender);
        }

        _pendingWithdraw[msg.sender] = withdrawAmount;
        FHE.allowThis(_pendingWithdraw[msg.sender]);
        FHE.makePubliclyDecryptable(_pendingWithdraw[msg.sender]);

        withdrawRequested[msg.sender] = true;
        withdrawRequestedAt[msg.sender] = block.timestamp;

        uint256 expiresAt = block.timestamp + WITHDRAW_TIMEOUT;
        emit WithdrawRequested(msg.sender, expiresAt);
    }

    function cancelWithdraw() external nonReentrant {
        if (!withdrawRequested[msg.sender]) revert WithdrawNotRequested();

        if (_balanceInitialized[msg.sender]) {
            _balances[msg.sender] = FHE.add(_balances[msg.sender], _pendingWithdraw[msg.sender]);
            FHE.allowThis(_balances[msg.sender]);
            FHE.allow(_balances[msg.sender], msg.sender);
        }

        _pendingWithdraw[msg.sender] = FHE.asEuint64(0);
        withdrawRequested[msg.sender] = false;
        withdrawRequestedAt[msg.sender] = 0;

        emit WithdrawCancelled(msg.sender);
    }

    function expireWithdraw(address user) external nonReentrant {
        if (!withdrawRequested[user]) revert WithdrawNotRequested();
        if (block.timestamp < withdrawRequestedAt[user] + WITHDRAW_TIMEOUT) revert WithdrawNotExpired();

        if (_balanceInitialized[user]) {
            _balances[user] = FHE.add(_balances[user], _pendingWithdraw[user]);
            FHE.allowThis(_balances[user]);
            FHE.allow(_balances[user], user);
        }

        _pendingWithdraw[user] = FHE.asEuint64(0);
        withdrawRequested[user] = false;
        withdrawRequestedAt[user] = 0;

        emit WithdrawExpired(user);
    }

    function finalizeWithdraw(
        uint64 clearAmount,
        bytes calldata decryptionProof
    ) external nonReentrant {
        if (!withdrawRequested[msg.sender]) revert WithdrawNotRequested();

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = FHE.toBytes32(_pendingWithdraw[msg.sender]);
        bytes memory abiClearValue = abi.encode(clearAmount);
        FHE.checkSignatures(handles, abiClearValue, decryptionProof);

        withdrawRequested[msg.sender] = false;
        withdrawRequestedAt[msg.sender] = 0;
        _pendingWithdraw[msg.sender] = FHE.asEuint64(0);

        if (clearAmount > 0) {
            uint64 fee = _calculateFee(clearAmount);
            uint64 netAmount = clearAmount - fee;

            if (netAmount > 0) {
                usdc.safeTransfer(msg.sender, uint256(netAmount));
            }

            if (fee > 0) {
                _creditTreasury(fee);
            }
        }

        emit WithdrawFinalized(msg.sender, clearAmount);
    }

    // ═══════════════════════════════════════
    // BALANCE QUERY
    // ═══════════════════════════════════════

    function requestBalance() external {
        if (!_balanceInitialized[msg.sender]) {
            return;
        }
        _balanceSnapshot[msg.sender] = FHE.add(_balances[msg.sender], FHE.asEuint64(0));
        FHE.allowThis(_balanceSnapshot[msg.sender]);
        FHE.makePubliclyDecryptable(_balanceSnapshot[msg.sender]);
        balanceQueryRequested[msg.sender] = true;

        emit BalanceRequested(msg.sender);
    }

    // ═══════════════════════════════════════
    // VIEW
    // ═══════════════════════════════════════

    function balanceOf(address account) external view returns (euint64) {
        return _balances[account];
    }

    function balanceSnapshotOf(address account) external view returns (euint64) {
        return _balanceSnapshot[account];
    }

    function isInitialized(address account) external view returns (bool) {
        return _balanceInitialized[account];
    }

    function pendingWithdrawOf(address account) external view returns (euint64) {
        return _pendingWithdraw[account];
    }

    function confidentialProtocolId() public view returns (uint256) {
        return ZamaConfig.getConfidentialProtocolId();
    }

    // ═══════════════════════════════════════
    // ADMIN — PAUSE
    // ═══════════════════════════════════════

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner whenPaused {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ═══════════════════════════════════════
    // ADMIN — TREASURY
    // ═══════════════════════════════════════

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        address old = treasury;

        if (_balanceInitialized[old]) {
            if (!_balanceInitialized[_treasury]) {
                _balances[_treasury] = _balances[old];
                _balanceInitialized[_treasury] = true;
            } else {
                _balances[_treasury] = FHE.add(_balances[_treasury], _balances[old]);
            }
            FHE.allowThis(_balances[_treasury]);
            FHE.allow(_balances[_treasury], _treasury);

            _balances[old] = FHE.asEuint64(0);
            FHE.allowThis(_balances[old]);
            FHE.allow(_balances[old], old);
        }

        treasury = _treasury;
        emit TreasuryUpdated(old, _treasury);
    }

    function treasuryWithdraw(uint64 amount) external nonReentrant {
        if (msg.sender != treasury && msg.sender != owner) revert OnlyOwner();
        if (amount == 0) revert ZeroAmount();
        if (!_balanceInitialized[treasury]) revert ZeroAmount();

        euint64 encAmount = FHE.asEuint64(amount);
        _balances[treasury] = FHE.sub(_balances[treasury], encAmount);
        FHE.allowThis(_balances[treasury]);
        FHE.allow(_balances[treasury], treasury);

        usdc.safeTransfer(treasury, uint256(amount));

        emit TreasuryWithdrawn(treasury, amount);
    }

    // ═══════════════════════════════════════
    // ADMIN — POOL CAPS
    // ═══════════════════════════════════════

    function setPoolCaps(uint256 _maxPoolBalance, uint256 _maxUserDeposit) external onlyOwner {
        maxPoolBalance = _maxPoolBalance;
        maxUserDeposit = _maxUserDeposit;
        emit PoolCapUpdated(_maxPoolBalance, _maxUserDeposit);
    }

    // ═══════════════════════════════════════
    // ADMIN — OWNERSHIP
    // ═══════════════════════════════════════

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

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

    function _calculateFee(uint64 amount) internal pure returns (uint64) {
        uint64 percentageFee = (amount * FEE_BPS) / BPS;
        return percentageFee > MIN_PROTOCOL_FEE ? percentageFee : MIN_PROTOCOL_FEE;
    }

    function _creditTreasury(uint64 fee) internal {
        euint64 encFee = FHE.asEuint64(fee);
        if (!_balanceInitialized[treasury]) {
            _balances[treasury] = encFee;
            _balanceInitialized[treasury] = true;
        } else {
            _balances[treasury] = FHE.add(_balances[treasury], encFee);
        }
        FHE.allowThis(_balances[treasury]);
        FHE.allow(_balances[treasury], treasury);
    }
}
