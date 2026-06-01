// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {MockStock} from "../src/mocks/MockERC20.sol";

contract MockStockTest is Test {
    function test_DeploysWithMetadataAndFaucet() public {
        MockStock s = new MockStock("Dinari dNVDA (Mock)", "dNVDA");
        assertEq(s.symbol(), "dNVDA", "symbol");
        assertEq(s.name(), "Dinari dNVDA (Mock)", "name");
        assertEq(s.decimals(), 6, "6 decimals (dShares)");

        address u = makeAddr("u");
        s.mint(u, 1234 * 1e6);
        assertEq(s.balanceOf(u), 1234 * 1e6, "faucet minted");
    }

    function test_MultipleStocksAreDistinct() public {
        MockStock a = new MockStock("Dinari dAAPL (Mock)", "dAAPL");
        MockStock b = new MockStock("Dinari dMSFT (Mock)", "dMSFT");
        assertTrue(address(a) != address(b), "distinct deployments");
        assertEq(a.symbol(), "dAAPL");
        assertEq(b.symbol(), "dMSFT");
    }
}
