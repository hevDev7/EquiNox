// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @title PythEquityFeeds
/// @notice Canonical Pyth regular-market-hours equity price-feed IDs
///         (Equity.US.<SYM>/USD), fetched from Pyth Hermes and adversarially
///         cross-verified. Feed IDs are chain-agnostic. Use these to wire a
///         `PythOracleAdapter` per tokenized-equity collateral.
/// @dev    Pyth pull-oracle on Arbitrum Sepolia per
///         https://docs.pyth.network/price-feeds/core/contract-addresses/evm
///         (re-verify against live docs before mainnet).
library PythEquityFeeds {
    address internal constant PYTH_ARBITRUM_SEPOLIA = 0x4374e5a8b9C22271E9EB878A2AA31DE97DF15DAF;

    bytes32 internal constant TSLA_USD = 0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1;
    bytes32 internal constant AAPL_USD = 0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688;
    bytes32 internal constant NVDA_USD = 0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593;
    bytes32 internal constant MSFT_USD = 0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1;
    bytes32 internal constant GOOGL_USD = 0x5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6;
    bytes32 internal constant AMZN_USD = 0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a;
    bytes32 internal constant META_USD = 0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe;
    bytes32 internal constant COIN_USD = 0xfee33f2a978bf32dd6b662b65ba8083c6773b494f8401194ec1870c640860245;
    bytes32 internal constant AMD_USD = 0x3622e381dbca2efd1859253763b1adc63f7f9abb8e76da1aa8e638a57ccde93e;
    bytes32 internal constant NFLX_USD = 0x8376cfd7ca8bcdf372ced05307b24dced1f15b1afafdeff715664598f15a3dd2;
    bytes32 internal constant PLTR_USD = 0x11a70634863ddffb71f2b11f2cff29f73f3db8f6d0b78c49f2b5f4ad36e885f0;
    bytes32 internal constant INTC_USD = 0xc1751e085ee292b8b3b9dd122a135614485a201c35dfc653553f0e28c1baf3ff;
    bytes32 internal constant JPM_USD = 0x7f4f157e57bfcccd934c566df536f34933e74338fe241a5425ce561acdab164e;
    bytes32 internal constant V_USD = 0xc719eb7bab9b2bc060167f1d1680eb34a29c490919072513b545b9785b73ee90;
    bytes32 internal constant DIS_USD = 0x703e36203020ae6761e6298975764e266fb869210db9b35dd4e4225fa68217d0;
    bytes32 internal constant BA_USD = 0x8419416ba640c8bbbcf2d464561ed7dd860db1e38e51cec9baf1e34c4be839ae;
    bytes32 internal constant MSTR_USD = 0xe1e80251e5f5184f2195008382538e847fafc36f751896889dd3d1b1f6111f09;
    bytes32 internal constant NKE_USD = 0x67649450b4ca4bfff97cbaf96d2fd9e40f6db148cb65999140154415e4378e14;
}
