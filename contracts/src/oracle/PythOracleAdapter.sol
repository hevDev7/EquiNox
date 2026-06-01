// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {IOracle} from "./IOracle.sol";

/// @title PythOracleAdapter — reads an equity price from a Pyth pull-feed (PRD §5.2).
/// @notice Normalizes the Pyth price (which carries an exponent) to whole-USD.
///         `priceUSD()` reverts via Pyth if the latest price is older than `maxAge`.
contract PythOracleAdapter is IOracle {
    uint256 public constant BPS = 10_000;

    IPyth public immutable pyth;
    bytes32 public immutable priceId;
    uint256 public immutable maxAge; // seconds (PRD: 60)
    uint256 public immutable maxConfBps; // reject if conf/price exceeds this (e.g. 200 = 2%)

    error NonPositivePrice();
    error UnexpectedExponent();
    error PriceTooUncertain();

    constructor(IPyth pyth_, bytes32 priceId_, uint256 maxAge_, uint256 maxConfBps_) {
        pyth = pyth_;
        priceId = priceId_;
        maxAge = maxAge_;
        maxConfBps = maxConfBps_;
    }

    function priceUSD() external view returns (uint64) {
        PythStructs.Price memory p = pyth.getPriceNoOlderThan(priceId, maxAge);
        if (p.price <= 0) revert NonPositivePrice();
        if (p.expo >= 0) revert UnexpectedExponent(); // equities feeds use a negative exponent
        uint256 raw = uint256(uint64(p.price));
        // reject prices whose confidence interval is too wide relative to the price
        if (uint256(p.conf) * BPS > raw * maxConfBps) revert PriceTooUncertain();
        uint256 scale = 10 ** uint256(uint32(uint32(-p.expo)));
        return uint64(raw / scale);
    }

    /// @notice Push fresh Pyth update data then read — call from the pool/keeper.
    function updateAndRead(bytes[] calldata updateData) external payable returns (uint64) {
        uint256 fee = pyth.getUpdateFee(updateData);
        pyth.updatePriceFeeds{value: fee}(updateData);
        return this.priceUSD();
    }
}
