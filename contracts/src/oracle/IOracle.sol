// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice Minimal oracle abstraction the pool reads collateral price from.
interface IOracle {
    /// @return Whole-USD price per share (the pool works in whole-USD units).
    function priceUSD() external view returns (uint64);
}
