// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {EclipseSettlement} from "../src/EclipseSettlement.sol";
import {EclipseRegistry} from "../src/EclipseRegistry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IReg {
    function getContractAddressByName(string calldata) external view returns (address);
}

interface IAssetManager {
    function fAsset() external view returns (address);
}

interface IFtso {
    function getFeedById(bytes21) external payable returns (uint256, int8, uint64);
}

interface IWNat {
    function deposit() external payable;
}

/// @title EclipseSettlement — Coston2 fork tests (NO MOCKS)
/// @notice Exercises the full settlement + registry flow against the REAL Flare
/// deployment on Coston2: the real `FlareContractRegistry`, the real `FtsoV2`
/// XRP/USD feed and `FeeCalculator`, and the real FXRP FAsset — all pulled in by
/// forking Coston2. No mock contracts exist anywhere in this suite.
///
/// Real balances, obtained the real way (both FXRP and WNat use checkpointed
/// vote-power ledgers, so a naive `deal` of the balance slot desyncs them):
///  - FXRP: transferred from a real on-chain FXRP holder at the pinned block.
///  - USD quote leg: minted 1:1 from native C2FLR via `WNat.deposit()`.
///
/// Quote-token note: Coston2 has no canonical USDT0 (USDT0 is a Flare *mainnet*
/// token, 0xe7cd86e13AC4309349F30B3435a9d337750fC82D). The settlement contract is
/// token-agnostic, so the USD quote leg here uses the real, registry-resolved
/// WNat (WC2FLR) token. In the deployed demo the operator supplies the real
/// quote ERC-20 via USDT0_ADDRESS.
contract EclipseSettlementForkTest is Test {
    address constant FLARE_REGISTRY = 0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019;
    bytes21 constant XRP_USD_FEED = 0x015852502f55534400000000000000000000000000;
    uint256 constant BAND_BPS = 50; // ±0.5%
    // Pinned so the live FTSO value and the whale balance are deterministic.
    uint256 constant FORK_BLOCK = 32482470;
    // A real FXRP holder at FORK_BLOCK (~234k FXRP); source of test balances.
    address constant FXRP_WHALE = 0xa70e82b73a41a68bf9cc27D98df4b2003E12f119;

    EclipseSettlement settlement;
    EclipseRegistry registry;

    address fxrp; // real FXRP FAsset (base)
    address usd; // real WNat, stands in for the USD quote leg on Coston2
    uint256 ftsoValue; // live XRP/USD read at the pinned block

    // Deterministic engine key so we can vm.sign as the attested signer.
    uint256 constant ENGINE_PK = 0xE9C1;
    address engine;
    // A never-registered key, for the UnattestedSigner path.
    uint256 constant ATTACKER_PK = 0xBAD;

    address deskA = address(0xA1);
    address deskB = address(0xB2);
    address deskC = address(0xC3);

    bytes32 constant CODE_HASH = keccak256("reproducible-build-code-hash");

    uint256 constant FXRP_UNIT = 1e6; // FXRP has 6 decimals
    uint256 constant USD_UNIT = 1e18; // WNat has 18 decimals

    function setUp() public {
        vm.createSelectFork(
            vm.envOr("COSTON2_RPC", string("https://coston2-api.flare.network/ext/C/rpc")),
            FORK_BLOCK
        );

        engine = vm.addr(ENGINE_PK);

        // Resolve REAL Flare protocol contracts from the REAL registry.
        IReg reg = IReg(FLARE_REGISTRY);
        address assetManager = reg.getContractAddressByName("AssetManagerFXRP");
        fxrp = IAssetManager(assetManager).fAsset();
        usd = reg.getContractAddressByName("WNat");
        address ftso = reg.getContractAddressByName("FtsoV2");
        (ftsoValue,,) = IFtso(ftso).getFeedById(XRP_USD_FEED);
        require(ftsoValue > 0, "no live FTSO value");

        // Eclipse contracts, wired to the real registry.
        registry = new EclipseRegistry(address(this));
        registry.registerCodeHash(CODE_HASH, engine);
        settlement = new EclipseSettlement(
            FLARE_REGISTRY, address(registry), fxrp, usd, XRP_USD_FEED, BAND_BPS
        );

        // Provision the desks on the REAL tokens.
        _fundFxrp(deskB, 1_000 * FXRP_UNIT);
        _fundFxrp(deskC, 1_000 * FXRP_UNIT);
        _fundUsd(deskA, 1_000 * USD_UNIT);
    }

    /// @dev Real FXRP, transferred from a real holder (keeps vote-power in sync).
    function _fundFxrp(address desk, uint256 amount) internal {
        vm.prank(FXRP_WHALE);
        IERC20(fxrp).transfer(desk, amount);
        vm.prank(desk);
        IERC20(fxrp).approve(address(settlement), type(uint256).max);
    }

    /// @dev Real WNat, minted 1:1 from native C2FLR (the canonical wrap path).
    function _fundUsd(address desk, uint256 amount) internal {
        vm.deal(desk, amount);
        vm.prank(desk);
        IWNat(usd).deposit{value: amount}();
        vm.prank(desk);
        IERC20(usd).approve(address(settlement), type(uint256).max);
    }

    // ─────────────────────────────────────────── signing helpers

    function _signSettlement(uint256 pk, EclipseSettlement.Settlement memory s)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(pk, settlement.settlementDigest(s));
        return abi.encodePacked(r, sig, v);
    }

    function _signCommit(uint256 pk, EclipseSettlement.BatchCommit memory c)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(pk, settlement.commitDigest(c));
        return abi.encodePacked(r, sig, v);
    }

    function _accounts2() internal view returns (address[] memory a) {
        a = new address[](2);
        a[0] = deskA;
        a[1] = deskB;
    }

    function _int2(int256 x, int256 y) internal pure returns (int256[] memory a) {
        a = new int256[](2);
        a[0] = x;
        a[1] = y;
    }

    function _commitAB(uint256 batchId, uint256 nonce) internal returns (uint256 expiry) {
        expiry = block.timestamp + 1 hours;
        EclipseSettlement.BatchCommit memory c = EclipseSettlement.BatchCommit({
            batchId: batchId,
            accounts: _accounts2(),
            expiry: expiry,
            nonce: nonce
        });
        settlement.commitBatch(c, _signCommit(ENGINE_PK, c));
    }

    // A buys 100 FXRP paying 50 USD; B sells 100 FXRP receiving 50 USD.
    function _happySettlement(uint256 expiry)
        internal
        view
        returns (EclipseSettlement.Settlement memory s)
    {
        s = EclipseSettlement.Settlement({
            batchId: 1,
            accounts: _accounts2(),
            fxrpDeltas: _int2(int256(100 * FXRP_UNIT), -int256(100 * FXRP_UNIT)),
            usdt0Deltas: _int2(-int256(50 * USD_UNIT), int256(50 * USD_UNIT)),
            clearingPrice: ftsoValue,
            ftsoRef: ftsoValue,
            expiry: expiry,
            nonce: 1
        });
    }

    // ─────────────────────────────────────────── deposit / withdraw

    function test_deposit_and_withdraw_idle_escrow() public {
        uint256 amt = 100 * FXRP_UNIT;
        vm.prank(deskB);
        settlement.deposit(fxrp, amt);
        assertEq(settlement.balanceOf(deskB, fxrp), amt);

        vm.prank(deskB);
        settlement.withdraw(fxrp, amt);
        assertEq(settlement.balanceOf(deskB, fxrp), 0);
        assertEq(IERC20(fxrp).balanceOf(deskB), 1_000 * FXRP_UNIT);
    }

    function test_double_withdraw_reverts() public {
        uint256 amt = 100 * FXRP_UNIT;
        vm.startPrank(deskB);
        settlement.deposit(fxrp, amt);
        settlement.withdraw(fxrp, amt);
        vm.expectRevert(EclipseSettlement.InsufficientEscrow.selector);
        settlement.withdraw(fxrp, amt);
        vm.stopPrank();
    }

    function test_unsupported_token_and_zero_amount_revert() public {
        vm.startPrank(deskA);
        vm.expectRevert(EclipseSettlement.UnsupportedToken.selector);
        settlement.deposit(address(0xdead), 1);
        vm.expectRevert(EclipseSettlement.ZeroAmount.selector);
        settlement.deposit(fxrp, 0);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────── happy path

    function test_settle_two_sided_batch_moves_net_balances() public {
        vm.prank(deskA);
        settlement.deposit(usd, 50 * USD_UNIT);
        vm.prank(deskB);
        settlement.deposit(fxrp, 100 * FXRP_UNIT);

        uint256 expiry = _commitAB(1, 1);
        EclipseSettlement.Settlement memory s = _happySettlement(expiry);
        settlement.settleBatch(s, _signSettlement(ENGINE_PK, s));

        assertEq(settlement.balanceOf(deskA, fxrp), 100 * FXRP_UNIT);
        assertEq(settlement.balanceOf(deskA, usd), 0);
        assertEq(settlement.balanceOf(deskB, usd), 50 * USD_UNIT);
        assertEq(settlement.balanceOf(deskB, fxrp), 0);

        // Legs cleared → both can withdraw their proceeds off the real tokens.
        vm.prank(deskA);
        settlement.withdraw(fxrp, 100 * FXRP_UNIT);
        vm.prank(deskB);
        settlement.withdraw(usd, 50 * USD_UNIT);
        assertEq(IERC20(fxrp).balanceOf(deskA), 100 * FXRP_UNIT);
        assertEq(IERC20(usd).balanceOf(deskB), 50 * USD_UNIT);
    }

    // ─────────────────────────────────────────── abuse paths
    // (signatures are computed BEFORE vm.expectRevert so the digest view call
    //  doesn't consume the cheatcode.)

    function test_unattested_signer_reverts() public {
        uint256 expiry = _commitAB(1, 1);
        EclipseSettlement.Settlement memory s = _happySettlement(expiry);
        bytes memory sig = _signSettlement(ATTACKER_PK, s);
        vm.expectRevert(EclipseSettlement.UnattestedSigner.selector);
        settlement.settleBatch(s, sig);
    }

    function test_price_outside_band_reverts() public {
        uint256 expiry = _commitAB(1, 1);
        EclipseSettlement.Settlement memory s = _happySettlement(expiry);
        s.clearingPrice = ftsoValue * 2; // far outside ±0.5%
        bytes memory sig = _signSettlement(ENGINE_PK, s);
        vm.expectRevert(EclipseSettlement.PriceOutsideBand.selector);
        settlement.settleBatch(s, sig);
    }

    function test_band_edge_accepted_and_just_past_reverts() public {
        uint256 edge = ftsoValue + (ftsoValue * BAND_BPS) / 10_000; // exactly +0.5%

        vm.prank(deskA);
        settlement.deposit(usd, 50 * USD_UNIT);
        vm.prank(deskB);
        settlement.deposit(fxrp, 100 * FXRP_UNIT);

        uint256 expiry = _commitAB(1, 1);
        EclipseSettlement.Settlement memory s = _happySettlement(expiry);
        s.clearingPrice = edge;
        settlement.settleBatch(s, _signSettlement(ENGINE_PK, s));

        // Fresh batch, one unit past the edge, must revert. Re-fund and re-commit.
        _fundUsd(deskA, 50 * USD_UNIT);
        _fundFxrp(deskB, 100 * FXRP_UNIT);
        vm.prank(deskA);
        settlement.deposit(usd, 50 * USD_UNIT);
        vm.prank(deskB);
        settlement.deposit(fxrp, 100 * FXRP_UNIT);
        uint256 expiry2 = _commitAB(2, 2);
        EclipseSettlement.Settlement memory s2 = _happySettlement(expiry2);
        s2.batchId = 2;
        s2.nonce = 2;
        s2.clearingPrice = edge + 1;
        bytes memory sig2 = _signSettlement(ENGINE_PK, s2);
        vm.expectRevert(EclipseSettlement.PriceOutsideBand.selector);
        settlement.settleBatch(s2, sig2);
    }

    function test_unbalanced_batch_reverts() public {
        uint256 expiry = _commitAB(1, 1);
        EclipseSettlement.Settlement memory s = _happySettlement(expiry);
        s.fxrpDeltas = _int2(int256(100 * FXRP_UNIT), -int256(99 * FXRP_UNIT)); // no conservation
        bytes memory sig = _signSettlement(ENGINE_PK, s);
        vm.expectRevert(EclipseSettlement.UnbalancedBatch.selector);
        settlement.settleBatch(s, sig);
    }

    function test_replayed_batch_reverts() public {
        vm.prank(deskA);
        settlement.deposit(usd, 50 * USD_UNIT);
        vm.prank(deskB);
        settlement.deposit(fxrp, 100 * FXRP_UNIT);

        uint256 expiry = _commitAB(1, 1);
        EclipseSettlement.Settlement memory s = _happySettlement(expiry);
        settlement.settleBatch(s, _signSettlement(ENGINE_PK, s));

        // Reuse nonce 1 in a fresh committed batch → ReplayedBatch.
        address[] memory one = new address[](1);
        one[0] = deskA;
        EclipseSettlement.BatchCommit memory c2 = EclipseSettlement.BatchCommit({
            batchId: 2, accounts: one, expiry: expiry, nonce: 2
        });
        settlement.commitBatch(c2, _signCommit(ENGINE_PK, c2));

        int256[] memory z = new int256[](1);
        EclipseSettlement.Settlement memory s2 = EclipseSettlement.Settlement({
            batchId: 2, accounts: one, fxrpDeltas: z, usdt0Deltas: z,
            clearingPrice: ftsoValue, ftsoRef: ftsoValue, expiry: expiry, nonce: 1
        });
        bytes memory sig2 = _signSettlement(ENGINE_PK, s2);
        vm.expectRevert(EclipseSettlement.ReplayedBatch.selector);
        settlement.settleBatch(s2, sig2);
    }

    function test_insufficient_escrow_reverts() public {
        uint256 expiry = _commitAB(1, 1);
        EclipseSettlement.Settlement memory s = _happySettlement(expiry);
        // A owes 500 USD but deposited nothing.
        s.usdt0Deltas = _int2(-int256(500 * USD_UNIT), int256(500 * USD_UNIT));
        s.fxrpDeltas = _int2(int256(0), int256(0));
        bytes memory sig = _signSettlement(ENGINE_PK, s);
        vm.expectRevert(EclipseSettlement.InsufficientEscrow.selector);
        settlement.settleBatch(s, sig);
    }

    function test_not_committed_reverts() public {
        _commitAB(1, 1);
        uint256 expiry = block.timestamp + 1 hours;
        address[] memory ac = new address[](2);
        ac[0] = deskA;
        ac[1] = deskC; // deskC never committed
        EclipseSettlement.Settlement memory s = EclipseSettlement.Settlement({
            batchId: 1, accounts: ac, fxrpDeltas: _int2(0, 0), usdt0Deltas: _int2(0, 0),
            clearingPrice: ftsoValue, ftsoRef: ftsoValue, expiry: expiry, nonce: 1
        });
        bytes memory sig = _signSettlement(ENGINE_PK, s);
        vm.expectRevert(EclipseSettlement.NotCommitted.selector);
        settlement.settleBatch(s, sig);
    }

    // ─────────────────────────────────────────── custody guard

    function test_open_leg_blocks_withdraw_but_not_idle_escrow() public {
        vm.prank(deskA);
        settlement.deposit(usd, 50 * USD_UNIT);
        vm.prank(deskB);
        settlement.deposit(fxrp, 100 * FXRP_UNIT);
        vm.prank(deskC);
        settlement.deposit(fxrp, 100 * FXRP_UNIT); // idle

        _commitAB(1, 1);

        vm.prank(deskA);
        vm.expectRevert(EclipseSettlement.OpenMatchedLeg.selector);
        settlement.withdraw(usd, 50 * USD_UNIT);

        // Idle desk C can always withdraw.
        vm.prank(deskC);
        settlement.withdraw(fxrp, 100 * FXRP_UNIT);
        assertEq(settlement.balanceOf(deskC, fxrp), 0);
    }

    function test_expired_leg_auto_release_restores_custody() public {
        vm.prank(deskA);
        settlement.deposit(usd, 50 * USD_UNIT);

        uint256 expiry = block.timestamp + 100;
        EclipseSettlement.BatchCommit memory c = EclipseSettlement.BatchCommit({
            batchId: 1, accounts: _accounts2(), expiry: expiry, nonce: 1
        });
        settlement.commitBatch(c, _signCommit(ENGINE_PK, c));

        vm.prank(deskA);
        vm.expectRevert(EclipseSettlement.OpenMatchedLeg.selector);
        settlement.withdraw(usd, 50 * USD_UNIT);

        // Engine never settled; after expiry the trader self-releases and withdraws.
        vm.warp(expiry + 1);
        vm.prank(deskA);
        settlement.releaseExpiredLeg();
        vm.prank(deskA);
        settlement.withdraw(usd, 50 * USD_UNIT);
        assertEq(settlement.balanceOf(deskA, usd), 0);
    }

    // ─────────────────────────────────────────── registry

    function test_registry_authorizes_and_revokes() public {
        assertTrue(registry.isAuthorized(engine));
        assertFalse(registry.isAuthorized(vm.addr(ATTACKER_PK)));

        registry.revokeCodeHash(CODE_HASH);
        assertFalse(registry.isAuthorized(engine));
    }

    function test_revoked_build_cannot_settle() public {
        uint256 expiry = _commitAB(1, 1);
        registry.revokeCodeHash(CODE_HASH);
        EclipseSettlement.Settlement memory s = _happySettlement(expiry);
        bytes memory sig = _signSettlement(ENGINE_PK, s);
        vm.expectRevert(EclipseSettlement.UnattestedSigner.selector);
        settlement.settleBatch(s, sig);
    }

    function test_only_owner_can_register() public {
        vm.prank(deskA);
        vm.expectRevert();
        registry.registerCodeHash(keccak256("x"), deskA);
    }
}
