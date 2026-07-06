// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {IEclipseRegistry} from "./interfaces/IEclipseRegistry.sol";
// Canonical Flare interfaces from the official periphery package (CLAUDE.md §3),
// not hand-rolled — these match the real Coston2 deployments exactly.
import {IFlareContractRegistry} from
    "@flarenetwork/flare-periphery-contracts/coston2/IFlareContractRegistry.sol";
import {FtsoV2Interface} from "@flarenetwork/flare-periphery-contracts/coston2/FtsoV2Interface.sol";
import {IFeeCalculator} from "@flarenetwork/flare-periphery-contracts/coston2/IFeeCalculator.sol";

/// @title EclipseSettlement
/// @notice Trustless escrow + net settlement for the Eclipse confidential dark
/// pool. Traders escrow real FXRP and USDT0; an attested TEE build signs the
/// per-account NET deltas of a batch; this contract verifies the signer is bound
/// to a whitelisted code-hash, checks the clearing price sits inside the FTSO
/// XRP/USD band, enforces conservation, and re-assigns escrow ownership.
///
/// Trust model (CLAUDE.md §2):
///  - The chain trusts the *build*, not the operator: only a signer bound to a
///    whitelisted code-hash in `EclipseRegistry` can settle.
///  - Custody is escrow-only and always redeemable: idle escrow is withdrawable
///    at any time; a leg locked for a batch auto-releases after its expiry, so
///    no admin key and no stuck batch can seize funds.
///  - Fairness is publicly checkable: the clearing price is bounded by the live
///    FTSO value read in the settlement tx, and the reference is emitted.
contract EclipseSettlement is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────── immutables / config

    IFlareContractRegistry public immutable flareRegistry;
    IEclipseRegistry public immutable eclipseRegistry;
    address public immutable fxrp;
    address public immutable usdt0;
    bytes21 public immutable xrpUsdFeedId;
    /// @notice Fairness band half-width in basis points (e.g. 50 = ±0.5%).
    uint256 public immutable bandBps;

    string private constant _FTSO_NAME = "FtsoV2";
    string private constant _FEE_CALC_NAME = "FeeCalculator";
    uint256 private constant _BPS = 10_000;

    // ─────────────────────────────────────────── state

    /// @dev account => token => escrowed balance (in token base units).
    mapping(address => mapping(address => uint256)) public escrow;

    /// @dev account => batchId it is currently locked into (0 = no open leg).
    mapping(address => uint256) public openLegBatch;
    /// @dev account => timestamp after which a locked leg self-releases.
    mapping(address => uint256) public openLegExpiry;

    /// @dev strictly-increasing replay guards, per engine.
    uint256 public lastCommitNonce;
    uint256 public lastSettlementNonce;

    /// @notice Emergency guardian: can halt NEW batch matching (commit/settle)
    /// without ever touching custody. Deposits, withdrawals and expired-leg
    /// self-release stay open even while paused, so funds are never frozen.
    address public guardian;
    /// @notice When true, `commitBatch`/`settleBatch` revert; custody stays open.
    bool public tradingPaused;

    // ─────────────────────────────────────────── EIP-712 typehashes

    bytes32 private constant SETTLEMENT_TYPEHASH = keccak256(
        "Settlement(uint256 batchId,address[] accounts,int256[] fxrpDeltas,int256[] usdt0Deltas,uint256 clearingPrice,uint256 ftsoRef,uint256 expiry,uint256 nonce)"
    );
    bytes32 private constant COMMIT_TYPEHASH =
        keccak256("BatchCommit(uint256 batchId,address[] accounts,uint256 expiry,uint256 nonce)");

    // ─────────────────────────────────────────── structs

    struct Settlement {
        uint256 batchId;
        address[] accounts;
        int256[] fxrpDeltas;
        int256[] usdt0Deltas;
        uint256 clearingPrice;
        uint256 ftsoRef;
        uint256 expiry;
        uint256 nonce;
    }

    struct BatchCommit {
        uint256 batchId;
        address[] accounts;
        uint256 expiry;
        uint256 nonce;
    }

    // ─────────────────────────────────────────── errors

    error UnsupportedToken();
    error ZeroAmount();
    error InsufficientEscrow();
    error OpenMatchedLeg();
    error UnattestedSigner();
    error PriceOutsideBand();
    error UnbalancedBatch();
    error ReplayedBatch();
    error BatchExpired();
    error LengthMismatch();
    error EmptyBatch();
    error NotCommitted();
    error AlreadyCommitted();
    error NoOpenLeg();
    error LegNotExpired();
    error InsufficientFtsoFee();
    error RefundFailed();
    error ZeroAddress();
    error TokensNotDistinct();
    error InvalidBatchId();
    error NotGuardian();
    error TradingHalted();

    // ─────────────────────────────────────────── events

    event Deposited(address indexed account, address indexed token, uint256 amount);
    event Withdrawn(address indexed account, address indexed token, uint256 amount);
    event BatchCommitted(uint256 indexed batchId, address indexed signer, uint256 accountCount);
    event BatchSettled(
        uint256 indexed batchId, uint256 clearingPrice, uint256 ftsoRef, uint256 ftsoOnChain, address signer
    );
    event LegReleased(address indexed account, uint256 indexed batchId);
    event TradingPauseSet(bool paused, address indexed by);
    event GuardianTransferred(address indexed previousGuardian, address indexed newGuardian);

    // ─────────────────────────────────────────── constructor

    constructor(
        address _flareRegistry,
        address _eclipseRegistry,
        address _fxrp,
        address _usdt0,
        bytes21 _feedId,
        uint256 _bandBps,
        address _guardian
    ) EIP712("Eclipse", "1") {
        if (
            _flareRegistry == address(0) || _eclipseRegistry == address(0) || _fxrp == address(0)
                || _usdt0 == address(0) || _guardian == address(0)
        ) revert ZeroAddress();
        // The two escrow tokens must be distinct — a shared address would collide
        // their escrow ledgers and let one leg's delta spend the other's balance.
        if (_fxrp == _usdt0) revert TokensNotDistinct();
        flareRegistry = IFlareContractRegistry(_flareRegistry);
        eclipseRegistry = IEclipseRegistry(_eclipseRegistry);
        fxrp = _fxrp;
        usdt0 = _usdt0;
        xrpUsdFeedId = _feedId;
        bandBps = _bandBps;
        guardian = _guardian;
        emit GuardianTransferred(address(0), _guardian);
    }

    // ─────────────────────────────────────────── guardian / pause

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    /// @notice Halt or resume NEW batch matching. Never affects custody: even
    /// while paused, traders can deposit, withdraw idle escrow, and self-release
    /// an expired leg. Emergency brake for an oracle/engine incident.
    function setTradingPaused(bool paused) external onlyGuardian {
        tradingPaused = paused;
        emit TradingPauseSet(paused, msg.sender);
    }

    /// @notice Hand the emergency guardian role to a new address (e.g. a multisig).
    function transferGuardian(address newGuardian) external onlyGuardian {
        if (newGuardian == address(0)) revert ZeroAddress();
        emit GuardianTransferred(guardian, newGuardian);
        guardian = newGuardian;
    }

    // ─────────────────────────────────────────── deposit / withdraw

    /// @notice Escrow real FXRP or USDT0 into the caller's account. Credits the
    /// amount ACTUALLY received, so a fee-on-transfer token (FAssets can enable a
    /// transfer fee) can never leave escrow crediting more than the contract holds.
    function deposit(address token, uint256 amount) external nonReentrant {
        _requireSupported(token);
        if (amount == 0) revert ZeroAmount();

        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        if (received == 0) revert ZeroAmount();

        escrow[msg.sender][token] += received;
        emit Deposited(msg.sender, token, received);
    }

    /// @notice Withdraw idle escrow. Reverts while the caller has an open matched
    /// leg in an unsettled batch (until that leg's expiry passes).
    function withdraw(address token, uint256 amount) external nonReentrant {
        _requireSupported(token);
        if (amount == 0) revert ZeroAmount();
        if (_hasOpenLeg(msg.sender)) revert OpenMatchedLeg();

        uint256 bal = escrow[msg.sender][token];
        if (bal < amount) revert InsufficientEscrow();
        unchecked {
            escrow[msg.sender][token] = bal - amount;
        }
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, token, amount);
    }

    // ─────────────────────────────────────────── batch lifecycle

    /// @notice Lock a batch's participants so their backing escrow cannot be
    /// pulled mid-batch. Signed by the attested engine. Only the participant set
    /// is revealed — never sides, amounts, prices, or fills.
    function commitBatch(BatchCommit calldata c, bytes calldata signature) external {
        if (tradingPaused) revert TradingHalted();
        // batchId 0 is the "no open leg" sentinel — a batch may never use it, or
        // the commit lock would silently no-op and settlement could apply deltas
        // to accounts that were never committed.
        if (c.batchId == 0) revert InvalidBatchId();
        if (block.timestamp > c.expiry) revert BatchExpired();
        if (c.accounts.length == 0) revert EmptyBatch();
        if (c.nonce <= lastCommitNonce) revert ReplayedBatch();

        address signer = _recoverCommit(c, signature);
        if (!eclipseRegistry.isAuthorized(signer)) revert UnattestedSigner();

        lastCommitNonce = c.nonce;
        uint256 n = c.accounts.length;
        for (uint256 i; i < n; ++i) {
            address a = c.accounts[i];
            if (_hasOpenLeg(a)) revert AlreadyCommitted();
            openLegBatch[a] = c.batchId;
            openLegExpiry[a] = c.expiry;
        }
        emit BatchCommitted(c.batchId, signer, n);
    }

    /// @notice Settle one batch: verify the attested signer, enforce the FTSO
    /// fairness band and per-token conservation, then re-assign escrow ownership
    /// by the signed net deltas. `payable` only to forward the (currently 0)
    /// FTSO feed fee; any excess is refunded.
    function settleBatch(Settlement calldata s, bytes calldata signature)
        external
        payable
        nonReentrant
    {
        if (tradingPaused) revert TradingHalted();
        if (s.batchId == 0) revert InvalidBatchId();
        if (block.timestamp > s.expiry) revert BatchExpired();
        if (s.nonce <= lastSettlementNonce) revert ReplayedBatch();

        uint256 n = s.accounts.length;
        if (n == 0) revert EmptyBatch();
        if (s.fxrpDeltas.length != n || s.usdt0Deltas.length != n) revert LengthMismatch();

        address signer = _recoverSettlement(s, signature);
        if (!eclipseRegistry.isAuthorized(signer)) revert UnattestedSigner();

        // Fairness: clearing price and the engine's reference must both sit
        // inside the band of the FTSO value read live in THIS tx.
        (uint256 ftsoValue, uint256 refund) = _readFtsoValue();
        if (!_withinBand(s.clearingPrice, ftsoValue)) revert PriceOutsideBand();
        if (!_withinBand(s.ftsoRef, ftsoValue)) revert PriceOutsideBand();

        // Conservation: each token's net deltas sum to zero across the batch.
        int256 fSum;
        int256 uSum;
        for (uint256 i; i < n; ++i) {
            fSum += s.fxrpDeltas[i];
            uSum += s.usdt0Deltas[i];
        }
        if (fSum != 0 || uSum != 0) revert UnbalancedBatch();

        lastSettlementNonce = s.nonce;

        // Effects: apply net deltas to escrow, clearing each account's leg.
        for (uint256 i; i < n; ++i) {
            address a = s.accounts[i];
            if (openLegBatch[a] != s.batchId) revert NotCommitted();
            _applyDelta(a, fxrp, s.fxrpDeltas[i]);
            _applyDelta(a, usdt0, s.usdt0Deltas[i]);
            openLegBatch[a] = 0;
            openLegExpiry[a] = 0;
        }

        emit BatchSettled(s.batchId, s.clearingPrice, s.ftsoRef, ftsoValue, signer);

        if (refund != 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @notice Self-release a leg the engine committed but never settled before
    /// its expiry. Guarantees always-redeemable custody even if the engine or
    /// relay goes dark mid-batch (CLAUDE.md §2.4).
    function releaseExpiredLeg() external {
        uint256 batchId = openLegBatch[msg.sender];
        if (batchId == 0) revert NoOpenLeg();
        if (block.timestamp <= openLegExpiry[msg.sender]) revert LegNotExpired();
        openLegBatch[msg.sender] = 0;
        openLegExpiry[msg.sender] = 0;
        emit LegReleased(msg.sender, batchId);
    }

    // ─────────────────────────────────────────── views

    function balanceOf(address account, address token) external view returns (uint256) {
        return escrow[account][token];
    }

    function hasOpenLeg(address account) external view returns (bool) {
        return _hasOpenLeg(account);
    }

    /// @notice The live FTSO XRP/USD reference the settlement path bounds every
    /// clearing price against. Not a `view` because the FTSO getter is `payable`,
    /// but the fee is currently 0 on Coston2 so it is callable read-only via
    /// `eth_call` (staticcall) with no value. Exposing it here lets a trader
    /// price an order against the *exact same* oracle reference the on-chain band
    /// check uses — no separate, drift-prone oracle path in the UI.
    /// @return value    XRP/USD value at the feed's native scale
    /// @return decimals the feed's decimal places
    /// @return timestamp the feed's last-update time
    function currentXrpUsdPrice()
        external
        returns (uint256 value, int8 decimals, uint64 timestamp)
    {
        FtsoV2Interface ftso = FtsoV2Interface(flareRegistry.getContractAddressByName(_FTSO_NAME));
        uint256 fee = _ftsoFee();
        (value, decimals, timestamp) = ftso.getFeedById{value: fee}(xrpUsdFeedId);
    }

    /// @notice EIP-712 digest for a settlement (exposed for tooling/tests).
    function settlementDigest(Settlement calldata s) external view returns (bytes32) {
        return _hashTypedDataV4(_structHashSettlement(s));
    }

    function commitDigest(BatchCommit calldata c) external view returns (bytes32) {
        return _hashTypedDataV4(_structHashCommit(c));
    }

    // ─────────────────────────────────────────── internal: settlement math

    function _applyDelta(address account, address token, int256 delta) private {
        if (delta < 0) {
            uint256 owed = uint256(-delta);
            uint256 bal = escrow[account][token];
            if (bal < owed) revert InsufficientEscrow();
            unchecked {
                escrow[account][token] = bal - owed;
            }
        } else if (delta > 0) {
            escrow[account][token] += uint256(delta);
        }
    }

    function _withinBand(uint256 price, uint256 ref) private view returns (bool) {
        if (ref == 0) return false;
        uint256 diff = price > ref ? price - ref : ref - price;
        return diff * _BPS <= bandBps * ref;
    }

    /// @dev Reads the live FTSO XRP/USD value, forwarding the (currently 0) fee.
    /// Returns the value and any msg.value to refund to the caller.
    function _readFtsoValue() private returns (uint256 value, uint256 refund) {
        FtsoV2Interface ftso = FtsoV2Interface(flareRegistry.getContractAddressByName(_FTSO_NAME));
        uint256 fee = _ftsoFee();
        if (msg.value < fee) revert InsufficientFtsoFee();
        (value,,) = ftso.getFeedById{value: fee}(xrpUsdFeedId);
        refund = msg.value - fee;
    }

    /// @dev Best-effort fee lookup; treats a missing/oddly-behaving FeeCalculator
    /// as fee 0 (current Coston2 behaviour) rather than bricking settlement.
    function _ftsoFee() private view returns (uint256) {
        address feeCalc = flareRegistry.getContractAddressByName(_FEE_CALC_NAME);
        if (feeCalc == address(0)) return 0;
        bytes21[] memory ids = new bytes21[](1);
        ids[0] = xrpUsdFeedId;
        try IFeeCalculator(feeCalc).calculateFeeByIds(ids) returns (uint256 fee) {
            return fee;
        } catch {
            return 0;
        }
    }

    // ─────────────────────────────────────────── internal: signatures

    function _recoverSettlement(Settlement calldata s, bytes calldata signature)
        private
        view
        returns (address)
    {
        return ECDSA.recover(_hashTypedDataV4(_structHashSettlement(s)), signature);
    }

    function _recoverCommit(BatchCommit calldata c, bytes calldata signature)
        private
        view
        returns (address)
    {
        return ECDSA.recover(_hashTypedDataV4(_structHashCommit(c)), signature);
    }

    function _structHashSettlement(Settlement calldata s) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SETTLEMENT_TYPEHASH,
                s.batchId,
                _hashAddresses(s.accounts),
                keccak256(abi.encodePacked(s.fxrpDeltas)),
                keccak256(abi.encodePacked(s.usdt0Deltas)),
                s.clearingPrice,
                s.ftsoRef,
                s.expiry,
                s.nonce
            )
        );
    }

    function _structHashCommit(BatchCommit calldata c) private pure returns (bytes32) {
        return keccak256(
            abi.encode(COMMIT_TYPEHASH, c.batchId, _hashAddresses(c.accounts), c.expiry, c.nonce)
        );
    }

    /// @dev EIP-712 array hash for `address[]`: each element encoded as 32 bytes.
    function _hashAddresses(address[] calldata accounts) private pure returns (bytes32) {
        uint256 n = accounts.length;
        bytes32[] memory padded = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            padded[i] = bytes32(uint256(uint160(accounts[i])));
        }
        return keccak256(abi.encodePacked(padded));
    }

    // ─────────────────────────────────────────── internal: misc

    function _requireSupported(address token) private view {
        if (token != fxrp && token != usdt0) revert UnsupportedToken();
    }

    function _hasOpenLeg(address account) private view returns (bool) {
        return openLegBatch[account] != 0 && block.timestamp <= openLegExpiry[account];
    }
}
