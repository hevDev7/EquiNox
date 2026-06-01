// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MockStock} from "../src/mocks/MockERC20.sol";
import {KYCRegistry} from "../src/KYCRegistry.sol";
import {EquinoxPoolV2} from "../src/EquinoxPoolV2.sol";

/// @notice Deploy EquinoxPoolV2 (multi-collateral) + register all 18 dShare equities, each
///         with its own open-mint MockStock token. Reuses the existing KYCRegistry + USDC.
///         TESTNET: weekend override ON, sequencer feed OFF, manual per-asset prices.
contract DeployV2 is Script {
    // 18-equity basket (whole-USD prices mirror src/config/stocks.ts).
    function _syms() internal pure returns (string[18] memory s) {
        s = [
            "dTSLA", "dAAPL", "dNVDA", "dMSFT", "dGOOGL", "dAMZN", "dMETA", "dCOIN", "dAMD",
            "dNFLX", "dPLTR", "dINTC", "dJPM", "dV", "dDIS", "dBA", "dMSTR", "dNKE"
        ];
    }

    function _prices() internal pure returns (uint64[18] memory p) {
        p = [
            uint64(342), 214, 138, 430, 178, 205, 581, 312, 121,
            892, 78, 21, 245, 315, 112, 178, 331, 76
        ];
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address usdc = vm.envAddress("USDC");
        address kyc = vm.envAddress("KYC_REGISTRY");

        vm.startBroadcast(pk);

        // 1. pool proxy (deployer = admin/governor/oracle-manager/pauser/upgrader)
        EquinoxPoolV2 impl = new EquinoxPoolV2();
        bytes memory init =
            abi.encodeCall(EquinoxPoolV2.initialize, (deployer, IERC20(usdc), KYCRegistry(kyc)));
        EquinoxPoolV2 pool = EquinoxPoolV2(address(new ERC1967Proxy(address(impl), init)));
        console2.log("EquinoxPoolV2 (proxy):", address(pool));
        console2.log("EquinoxPoolV2 (impl): ", address(impl));

        // 2. testnet ergonomics: bypass weekend breaker; sequencer feed stays unset (off).
        pool.setWeekendOverride(true);

        // 3. deploy + register all 18 dShare collaterals (LTV 70% / LT 80% / bonus 7.5%, uncapped).
        string[18] memory syms = _syms();
        uint64[18] memory prices = _prices();
        for (uint256 i = 0; i < 18; i++) {
            MockStock tok = new MockStock(syms[i], syms[i]);
            uint256 id = pool.addAsset(IERC20(address(tok)), prices[i], 7000, 8000, 750, 0, 6);
            console2.log(string.concat("asset ", vm.toString(id), " ", syms[i], ":"), address(tok));
        }

        vm.stopBroadcast();
        console2.log("assetCount:", pool.assetCount());
    }
}
