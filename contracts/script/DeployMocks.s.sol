// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console} from "forge-std/Script.sol";
import {MockStock} from "../src/mocks/MockERC20.sol";

/// @notice Deploys the full basket of mock tokenized-equity (dShare) tokens for richer
///         Arbitrum Sepolia testing, and faucets each to the deployer.
///         USDC is NOT mocked — use the official Circle USDC
///         (0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d, faucet.circle.com).
///
///   ⚠️ TESTNET/DEMO ONLY — every dShare token has an open `mint` faucet.
///
///   forge script script/DeployMocks.s.sol:DeployMocks \
///     --rpc-url $ARBITRUM_SEPOLIA_RPC --private-key $PK --broadcast
contract DeployMocks is Script {
    uint256 constant FAUCET = 1_000_000 * 1e6; // 1M units (6 decimals)
    address constant USDC_ARBITRUM_SEPOLIA = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;

    function run() external {
        string[18] memory names = [
            "Dinari dTSLA (Mock)",
            "Dinari dAAPL (Mock)",
            "Dinari dNVDA (Mock)",
            "Dinari dMSFT (Mock)",
            "Dinari dGOOGL (Mock)",
            "Dinari dAMZN (Mock)",
            "Dinari dMETA (Mock)",
            "Dinari dCOIN (Mock)",
            "Dinari dAMD (Mock)",
            "Dinari dNFLX (Mock)",
            "Dinari dPLTR (Mock)",
            "Dinari dINTC (Mock)",
            "Dinari dJPM (Mock)",
            "Dinari dV (Mock)",
            "Dinari dDIS (Mock)",
            "Dinari dBA (Mock)",
            "Dinari dMSTR (Mock)",
            "Dinari dNKE (Mock)"
        ];
        string[18] memory syms = [
            "dTSLA",
            "dAAPL",
            "dNVDA",
            "dMSFT",
            "dGOOGL",
            "dAMZN",
            "dMETA",
            "dCOIN",
            "dAMD",
            "dNFLX",
            "dPLTR",
            "dINTC",
            "dJPM",
            "dV",
            "dDIS",
            "dBA",
            "dMSTR",
            "dNKE"
        ];

        vm.startBroadcast();
        for (uint256 i = 0; i < syms.length; i++) {
            MockStock s = new MockStock(names[i], syms[i]);
            s.mint(msg.sender, FAUCET);
            console.log(syms[i], address(s));
        }
        vm.stopBroadcast();

        console.log("USDC (official Circle, not mocked):", USDC_ARBITRUM_SEPOLIA);
        console.log("Faucet minted (1,000,000 units each, 6 decimals) to", msg.sender);
    }
}
