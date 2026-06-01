// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {PythOracleAdapter} from "../src/oracle/PythOracleAdapter.sol";

/// @notice Exercises the real Pyth pull-feed path via the official MockPyth.
///         (Migrated to plain forge-std Test — the adapter uses no FHE. The old
///         pool.syncPrice() integration test was dropped: EquinoxPoolV2 uses per-asset
///         setAssetPrice, not the single-asset syncPrice/setOracle removed in V2.)
contract PythOracleTest is Test {
    MockPyth pyth;

    bytes32 constant FEED = bytes32(uint256(0xAA51)); // TSLA/USD feed id (test)

    function setUp() public {
        vm.warp(1_704_283_200);
        pyth = new MockPyth(60, 0); // validTimePeriod 60s, zero fee
    }

    function _publish(int64 priceE8) internal {
        bytes[] memory upd = new bytes[](1);
        upd[0] = pyth.createPriceFeedUpdateData(FEED, priceE8, 1e6, -8, priceE8, 1e6, uint64(block.timestamp), 0);
        uint256 fee = pyth.getUpdateFee(upd);
        pyth.updatePriceFeeds{value: fee}(upd);
    }

    function test_PythAdapter_NormalizesToWholeUsd() public {
        _publish(int64(500 * 1e8)); // $500.00, expo -8
        PythOracleAdapter adapter = new PythOracleAdapter(IPyth(address(pyth)), FEED, 60, 200);
        assertEq(adapter.priceUSD(), 500, "expo-normalized to whole USD");
    }

    function test_PythAdapter_RevertsOnStalePrice() public {
        _publish(int64(500 * 1e8));
        PythOracleAdapter adapter = new PythOracleAdapter(IPyth(address(pyth)), FEED, 60, 200);
        vm.warp(block.timestamp + 120); // older than maxAge
        vm.expectRevert();
        adapter.priceUSD();
    }

    function test_PythAdapter_RevertsOnWideConfidence() public {
        // conf == price (100%), far above the 2% (200 bps) cap
        bytes[] memory upd = new bytes[](1);
        upd[0] = pyth.createPriceFeedUpdateData(
            FEED, int64(500 * 1e8), uint64(500 * 1e8), -8, int64(500 * 1e8), uint64(500 * 1e8), uint64(block.timestamp), 0
        );
        pyth.updatePriceFeeds{value: pyth.getUpdateFee(upd)}(upd);
        PythOracleAdapter adapter = new PythOracleAdapter(IPyth(address(pyth)), FEED, 60, 200);
        vm.expectRevert(PythOracleAdapter.PriceTooUncertain.selector);
        adapter.priceUSD();
    }

    function test_PythAdapter_RevertsOnNonPositivePrice() public {
        _publish(int64(0)); // price 0
        PythOracleAdapter adapter = new PythOracleAdapter(IPyth(address(pyth)), FEED, 60, 200);
        vm.expectRevert(PythOracleAdapter.NonPositivePrice.selector);
        adapter.priceUSD();
    }

    function test_PythAdapter_RevertsOnNonNegativeExponent() public {
        bytes[] memory upd = new bytes[](1);
        upd[0] = pyth.createPriceFeedUpdateData(FEED, int64(500), 1, 0, int64(500), 1, uint64(block.timestamp), 0); // expo 0
        pyth.updatePriceFeeds{value: pyth.getUpdateFee(upd)}(upd);
        PythOracleAdapter adapter = new PythOracleAdapter(IPyth(address(pyth)), FEED, 60, 200);
        vm.expectRevert(PythOracleAdapter.UnexpectedExponent.selector);
        adapter.priceUSD();
    }
}
