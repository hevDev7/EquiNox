// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console2} from "forge-std/Script.sol";
import {EquinoxPoolV2} from "../src/EquinoxPoolV2.sol";

/// @notice UUPS-upgrade the live EquinoxPoolV2 proxy to a fresh impl (adds HF-gated
///         withdrawCollateral). Deployer must hold UPGRADER_ROLE. No reinit needed
///         (no new storage), so upgradeToAndCall is called with empty data.
contract UpgradePoolV2 is Script {
    address constant PROXY = 0xA1a36C6582128253C88f316CCF9d8384155D3d92;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        EquinoxPoolV2 newImpl = new EquinoxPoolV2();
        EquinoxPoolV2(PROXY).upgradeToAndCall(address(newImpl), "");
        vm.stopBroadcast();
        console2.log("EquinoxPoolV2 proxy:    ", PROXY);
        console2.log("EquinoxPoolV2 new impl: ", address(newImpl));
    }
}
