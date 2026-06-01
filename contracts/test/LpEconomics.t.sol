// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC, MockDShares} from "../src/mocks/MockERC20.sol";
import {KYCRegistry} from "../src/KYCRegistry.sol";
import {EquinoxPool} from "../src/EquinoxPool.sol";

/// @notice Batch C — LP economics (supply index + reserve factor + utilization-based kinked rate).
///         This suite is FHE-FREE: provideLiquidity / withdrawLiquidity / _accrue / the rate model
///         touch no sealed state, so we can deploy a bare proxy and verify the interest math with
///         `vm.warp` (impossible on a live testnet, where seconds of accrual round to 0 bps).
///         Utilization is driven by `deal()`-ing the pool's USDC balance to emulate borrowed-out
///         funds without running the confidential borrow path.
contract LpEconomicsTest is Test {
    MockUSDC usdc;
    MockDShares dsh;
    EquinoxPool pool;

    address admin = makeAddr("admin");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant BPS = 10_000;
    uint256 constant USDC_UNIT = 1e6;
    uint256 constant YEAR = 365 days;
    uint64 constant PRICE = 342;

    function setUp() public {
        vm.warp(1_704_283_200); // fixed start
        usdc = new MockUSDC();
        dsh = new MockDShares();

        EquinoxPool impl = new EquinoxPool();
        bytes memory init = abi.encodeCall(
            EquinoxPool.initialize,
            (admin, IERC20(address(dsh)), IERC20(address(usdc)), KYCRegistry(address(0xCAFE)), PRICE)
        );
        pool = EquinoxPool(address(new ERC1967Proxy(address(impl), init)));

        // fund LPs
        usdc.mint(alice, 1_000_000 * USDC_UNIT);
        usdc.mint(bob, 1_000_000 * USDC_UNIT);
        vm.prank(alice);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(pool), type(uint256).max);
    }

    function _provide(address who, uint256 whole) internal {
        vm.prank(who);
        pool.provideLiquidity(whole);
    }

    // ---- supply-share accounting ------------------------------------------------

    function test_provide_mintsParShares_atUnitIndex() public {
        _provide(alice, 1000);
        // si starts at 1.0 → scaled shares == whole USDC
        assertEq(pool.lpShares(alice), 1000, "scaled shares");
        assertEq(pool.totalLpSupplied(), 1000, "total scaled");
        assertEq(pool.lpBalanceOf(alice), 1000, "claimable USDC");
        assertEq(pool.totalSuppliedUsdc(), 1000, "total claimable");
        assertEq(pool.availableLiquidity(), 1000, "free USDC");
    }

    function test_withdraw_returnsPrincipal_noUtil() public {
        _provide(alice, 1000);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        pool.withdrawLiquidity(400);
        assertEq(usdc.balanceOf(alice) - before, 400 * USDC_UNIT, "got 400 USDC");
        assertEq(pool.lpBalanceOf(alice), 600, "600 left");
    }

    // ---- utilization + kinked rate curve ---------------------------------------

    /// @dev Drive utilization by shrinking the pool's USDC balance (emulates borrowed-out funds).
    function _setUtil(uint256 utilBps) internal {
        uint256 suppliedUsdc = pool.totalSuppliedUsdc();
        uint256 freeUsdc = suppliedUsdc - (suppliedUsdc * utilBps / BPS);
        deal(address(usdc), address(pool), freeUsdc * USDC_UNIT);
    }

    function test_utilization_zeroWhenFullyFree() public {
        _provide(alice, 1000);
        assertEq(pool.utilizationBps(), 0);
        assertEq(pool.currentBorrowRateBps(), 0, "0% borrow rate idle");
        assertEq(pool.currentSupplyRateBps(), 0, "0% supply rate idle");
    }

    function test_rate_belowKink_isLinear() public {
        _provide(alice, 1000);
        _setUtil(4000); // 40% util, below 80% kink
        assertEq(pool.utilizationBps(), 4000);
        // base(0) + slope1(600)*4000/8000 = 300 bps
        assertEq(pool.currentBorrowRateBps(), 300, "3% APR at 40% util");
    }

    function test_rate_atKink() public {
        _provide(alice, 1000);
        _setUtil(8000);
        assertEq(pool.utilizationBps(), 8000);
        assertEq(pool.currentBorrowRateBps(), 600, "6% APR at the kink");
    }

    function test_rate_aboveKink_isSteep() public {
        _provide(alice, 1000);
        _setUtil(10_000); // 100% util
        assertEq(pool.utilizationBps(), 10_000);
        // base(0) + slope1(600) + slope2(6000)*(10000-8000)/(10000-8000) = 6600 bps
        assertEq(pool.currentBorrowRateBps(), 6600, "66% APR at 100% util");
    }

    function test_supplyRate_isBorrowRate_x_util_x_oneMinusReserve() public {
        _provide(alice, 1000);
        _setUtil(8000);
        // supplyRate = 600 * 0.8 * (1 - 0.15) = 408 bps
        assertEq(pool.currentSupplyRateBps(), 408, "supply APR net of reserve");
    }

    // ---- interest accrual over time (the part on-chain can't show) -------------

    function test_accrual_growsSupplyIndex_borrowIndex_andReserve() public {
        _provide(alice, 1000);
        _setUtil(8000); // 80% util → borrow 6% APR, 800 USDC borrowed-out

        uint256 si0 = pool.supplyIndexBps();
        uint256 bi0 = pool.storedIndexBps();
        assertEq(si0, 0, "supplyIndex lazy-0 == 1.0");
        assertEq(bi0, BPS, "borrowIndex starts 1.0");

        vm.warp(block.timestamp + YEAR);

        // project the views forward
        assertApproxEqAbs(pool.currentBorrowRateBps(), 600, 0);
        // borrow index after ~1yr at 6%: 10000 -> ~10600
        assertApproxEqAbs(pool.currentIndexBps(), 10_600, 5, "borrow index +~6%");
        // supply index after ~1yr at 4.08%: ~10408
        assertApproxEqAbs(pool.currentSupplyIndexBps(), 10_408, 5, "supply index +~4.08%");

        // settle by a poke (tiny provide triggers _accrue)
        usdc.mint(bob, 1 * USDC_UNIT);
        // bob needs to top free balance so provide doesn't change util mid-accrual materially
        _provide(bob, 1);

        uint256 si1 = pool.supplyIndexBps();
        assertGt(si1, BPS, "supply index grew past 1.0");
        assertGt(pool.storedIndexBps(), bi0, "borrow index grew");
        assertGt(pool.reserveAccruedUsdc(), 0, "protocol reserve accrued");

        // reserve ~= borrowed(800) * 6% * 15% over 1yr = 800 * 0.06 * 0.15 = 7.2 USDC
        uint256 reserveUsdc = pool.reserveAccruedUsdc() / USDC_UNIT;
        assertApproxEqAbs(reserveUsdc, 7, 1, "~7.2 USDC reserve");
    }

    /// @dev `_accrue` settles at the instantaneous utilization, so the index must be poked
    ///      while utilization is still high — THEN the borrower repays (pool funded) and the LP
    ///      withdraws principal+yield. Mirrors the live cadence where _accrue runs every op.
    function _pokeAccrual() internal {
        vm.prank(admin);
        pool.setBorrowRate(DEFAULT_RATE_BPS_LEGACY); // governor no-op that triggers _accrue()
    }

    uint64 constant DEFAULT_RATE_BPS_LEGACY = 480;

    function test_lpEarnsYield_onWithdraw() public {
        _provide(alice, 1000);
        _setUtil(8000);
        vm.warp(block.timestamp + YEAR);
        _pokeAccrual(); // lock in the year's accrual while utilization is still 80%

        uint256 claimable = pool.lpBalanceOf(alice);
        assertGt(claimable, 1000, "Alice's claim grew above principal");
        assertApproxEqAbs(claimable, 1040, 2, "~4.08% LP yield");

        // borrower repays principal+interest → pool now holds USDC to cover the LP's grown claim
        deal(address(usdc), address(pool), 2000 * USDC_UNIT);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        pool.withdrawLiquidity(claimable);
        assertApproxEqAbs((usdc.balanceOf(alice) - before) / USDC_UNIT, claimable, 1, "yield realized");
    }

    function test_reserve_withdrawableByGovernor() public {
        _provide(alice, 1000);
        _setUtil(8000); // free = 200 USDC
        vm.warp(block.timestamp + YEAR);
        _pokeAccrual(); // accrue reserve while utilization is still 80%

        uint256 reserve = pool.reserveAccruedUsdc();
        assertGt(reserve, 0, "reserve accrued");
        vm.prank(admin);
        pool.withdrawReserve(admin, reserve); // 200 USDC free covers the ~7.2 USDC reserve
        assertEq(pool.reserveAccruedUsdc(), 0, "reserve drained");
        assertEq(usdc.balanceOf(admin), reserve, "treasury funded");
    }

    function test_twoLPs_shareYieldProRata() public {
        _provide(alice, 1000);
        _provide(bob, 3000); // bob 3x alice
        _setUtil(8000);
        vm.warp(block.timestamp + YEAR);
        _pokeAccrual();

        uint256 aGain = pool.lpBalanceOf(alice) - 1000;
        uint256 bGain = pool.lpBalanceOf(bob) - 3000;
        assertGt(aGain, 0, "alice earned yield");
        assertApproxEqAbs(bGain, aGain * 3, 3, "pro-rata yield split (bob 3x)");
    }
}
