// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal mock ERC20 with a public faucet and configurable decimals.
contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    /// @notice Open faucet for testnet/demo use.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Mock USDC payment token (6 decimals) — PRD ref 0x71E3...985D.
contract MockUSDC is MockERC20 {
    constructor() MockERC20("USD Coin (Mock)", "USDC", 6) {}
}

/// @notice Mock Dinari dShares testnet token (6 decimals) — PRD ref 0x1be2...1d89.
contract MockDShares is MockERC20 {
    constructor() MockERC20("Dinari dTSLA (Mock)", "dTSLA", 6) {}
}

/// @notice Generic mock tokenized-equity (dShare), name/symbol chosen at deploy.
///         dShares use 6 decimals per the PRD. Open faucet — TESTNET/DEMO ONLY.
contract MockStock is MockERC20 {
    constructor(string memory name_, string memory symbol_) MockERC20(name_, symbol_, 6) {}
}
