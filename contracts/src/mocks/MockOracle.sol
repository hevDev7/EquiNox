// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IOracle} from "../oracle/IOracle.sol";

/// @notice Minimal settable oracle for tests/demos — models the trusted price source
///         feeding `EquinoxPool.syncPrice()` (the realistic path for large market moves,
///         which the bounded manual `setPrice` deliberately cannot make in one step).
contract MockOracle is IOracle {
    uint64 public price;

    constructor(uint64 price_) {
        price = price_;
    }

    function set(uint64 price_) external {
        price = price_;
    }

    function priceUSD() external view returns (uint64) {
        return price;
    }
}
