// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC, MockStock} from "../src/mocks/MockERC20.sol";
import {KYCRegistry} from "../src/KYCRegistry.sol";
import {EquinoxPoolV2} from "../src/EquinoxPoolV2.sol";

/// @notice Batch D — V2 multi-collateral REGISTRY + LP economics carry-over.
///         FHE-FREE: covers the asset registry (addAsset / setAssetConfig / setAssetPrice /
///         staleness) and the debt-side LP economics, none of which touch sealed state.
///         The confidential core (aggregated borrow capacity, multi-asset HF, per-asset
///         seize) calls FHE precompiles and is verified on the live CoFHE testnet (D3).
contract PoolV2RegistryTest is Test {
    MockUSDC usdc;
    EquinoxPoolV2 pool;
    address admin = makeAddr("admin");
    address alice = makeAddr("alice");
    address rando = makeAddr("rando");

    uint256 constant BPS = 10_000;
    uint256 constant USDC_UNIT = 1e6;
    uint256 constant YEAR = 365 days;

    function setUp() public {
        vm.warp(1_704_283_200);
        usdc = new MockUSDC();
        EquinoxPoolV2 impl = new EquinoxPoolV2();
        bytes memory init =
            abi.encodeCall(EquinoxPoolV2.initialize, (admin, IERC20(address(usdc)), KYCRegistry(address(0xCAFE))));
        pool = EquinoxPoolV2(address(new ERC1967Proxy(address(impl), init)));
    }

    function _add(string memory sym, uint64 price, uint64 ltv, uint64 lt) internal returns (uint256 id) {
        MockStock t = new MockStock(sym, sym);
        vm.prank(admin);
        id = pool.addAsset(IERC20(address(t)), price, ltv, lt, 750, 0, 6);
    }

    // ---- registry --------------------------------------------------------------

    function test_addAsset_incrementsAndStores() public {
        uint256 a = _add("dTSLA", 342, 7000, 8000);
        uint256 b = _add("dAAPL", 214, 7500, 8500);
        assertEq(a, 0);
        assertEq(b, 1);
        assertEq(pool.assetCount(), 2);
        (, uint64 price,, uint64 ltv, uint64 lt,,,, bool enabled,) = pool.assets(0);
        assertEq(price, 342);
        assertEq(ltv, 7000);
        assertEq(lt, 8000);
        assertTrue(enabled);
    }

    function test_addAsset_onlyGovernor() public {
        MockStock t = new MockStock("dX", "dX");
        vm.prank(rando);
        vm.expectRevert();
        pool.addAsset(IERC20(address(t)), 100, 7000, 8000, 750, 0, 6);
    }

    function test_addAsset_rejectsBadConfig() public {
        MockStock t = new MockStock("dX", "dX");
        vm.startPrank(admin);
        vm.expectRevert(EquinoxPoolV2.BadConfig.selector);
        pool.addAsset(IERC20(address(t)), 100, 0, 8000, 750, 0, 6); // ltv 0
        vm.expectRevert(EquinoxPoolV2.BadConfig.selector);
        pool.addAsset(IERC20(address(t)), 100, 9000, 8000, 750, 0, 6); // ltv > lt
        vm.expectRevert(EquinoxPoolV2.BadConfig.selector);
        pool.addAsset(IERC20(address(t)), 100, 7000, 11000, 750, 0, 6); // lt > BPS
        vm.expectRevert(EquinoxPoolV2.PriceOutOfBounds.selector);
        pool.addAsset(IERC20(address(t)), 0, 7000, 8000, 750, 0, 6); // price 0
        vm.stopPrank();
    }

    function test_setAssetConfig_updates() public {
        uint256 id = _add("dTSLA", 342, 7000, 8000);
        vm.prank(admin);
        pool.setAssetConfig(id, 6000, 7500, 1000, 5000, false);
        (,,, uint64 ltv, uint64 lt, uint64 bonus, uint128 cap,, bool enabled,) = pool.assets(id);
        assertEq(ltv, 6000);
        assertEq(lt, 7500);
        assertEq(bonus, 1000);
        assertEq(cap, 5000);
        assertFalse(enabled);
    }

    // ---- price + staleness -----------------------------------------------------

    function test_setAssetPrice_deviationCap() public {
        uint256 id = _add("dTSLA", 1000, 7000, 8000);
        vm.startPrank(admin);
        pool.setAssetPrice(id, 1200); // +20% ok (boundary)
        vm.expectRevert(EquinoxPoolV2.PriceDeviationTooHigh.selector);
        pool.setAssetPrice(id, 1500); // +25% from 1200 → reject
        vm.stopPrank();
    }

    function test_priceStale_perAssetAndGlobal() public {
        uint256 id = _add("dTSLA", 342, 7000, 8000);
        assertFalse(pool.isPriceStale());
        assertFalse(pool.isAssetPriceStale(id));
        vm.warp(block.timestamp + pool.STALENESS() + 1); // past the configured staleness window
        assertTrue(pool.isAssetPriceStale(id));
        assertTrue(pool.isPriceStale());
        vm.prank(admin);
        pool.setAssetPrice(id, 350);
        assertFalse(pool.isPriceStale());
    }

    function test_lastPriceUpdateAt_bumpsOnPrice() public {
        uint256 id = _add("dTSLA", 342, 7000, 8000);
        uint256 t0 = pool.lastPriceUpdateAt();
        vm.warp(block.timestamp + 30);
        vm.prank(admin);
        pool.setAssetPrice(id, 350);
        assertGt(pool.lastPriceUpdateAt(), t0);
    }

    function test_factorsStale_trueBeforeSettle() public {
        _add("dTSLA", 342, 7000, 8000);
        // factorsAt[alice] = 0 < lastPriceUpdateAt → stale (HF would be untrustworthy)
        assertTrue(pool.factorsStale(alice));
    }

    // ---- LP economics carried over from Batch C --------------------------------

    function test_lp_economics_carryOver() public {
        usdc.mint(alice, 10_000 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(pool), type(uint256).max);
        pool.provideLiquidity(1000);
        vm.stopPrank();

        assertEq(pool.lpBalanceOf(alice), 1000);
        assertEq(pool.totalSuppliedUsdc(), 1000);
        assertEq(pool.utilizationBps(), 0); // all free

        // drive utilization to the kink and check the rate curve still holds in V2
        deal(address(usdc), address(pool), 200 * USDC_UNIT); // 80% out
        assertEq(pool.utilizationBps(), 8000);
        assertEq(pool.currentBorrowRateBps(), 600); // 6% at kink
        assertEq(pool.currentSupplyRateBps(), 408); // net of 15% reserve

        vm.warp(block.timestamp + YEAR);
        vm.prank(admin);
        pool.setBorrowRate(480); // poke accrual while util high
        assertGt(pool.lpBalanceOf(alice), 1000); // earned yield
        assertGt(pool.reserveAccruedUsdc(), 0);
    }
}
