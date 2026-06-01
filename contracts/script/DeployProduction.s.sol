// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {KYCRegistry} from "../src/KYCRegistry.sol";
import {EquinoxPool} from "../src/EquinoxPool.sol";
import {FHERC20Wrapper} from "../src/FHERC20Wrapper.sol";
import {PythOracleAdapter} from "../src/oracle/PythOracleAdapter.sol";

/// @notice Production deploy: UUPS proxies governed by a TimelockController whose
///         proposer/executor is a multisig (e.g. Safe). All admin/governance/oracle/
///         pauser/upgrader roles are held by the timelock from genesis.
///
///   env: MULTISIG (Safe), TIMELOCK_DELAY (s, default 2d), PYTH, TSLA_FEED_ID,
///        DSHARES, USDC  (real token addresses on Arbitrum Sepolia)
///
///   forge script script/DeployProduction.s.sol:DeployProduction \
///     --rpc-url $ARBITRUM_SEPOLIA_RPC --private-key $PK --broadcast
///
///   After deploy, wire the oracle via a timelock proposal:
///     pool.setOracle(adapter)  — schedule + execute through the Safe.
contract DeployProduction is Script {
    function run() external {
        address multisig = vm.envAddress("MULTISIG");
        uint256 minDelay = vm.envOr("TIMELOCK_DELAY", uint256(2 days));
        address pyth = vm.envAddress("PYTH");
        bytes32 feedId = vm.envBytes32("TSLA_FEED_ID");
        address dshares = vm.envAddress("DSHARES");
        // official Circle USDC on Arbitrum Sepolia (override via env USDC)
        address usdc = vm.envOr("USDC", address(0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d));

        vm.startBroadcast();

        // timelock: proposer + executor = multisig; no separate admin (self-administered)
        address[] memory proposers = new address[](1);
        proposers[0] = multisig;
        address[] memory executors = new address[](1);
        executors[0] = multisig;
        TimelockController timelock = new TimelockController(minDelay, proposers, executors, address(0));
        address admin = address(timelock);

        address attester = vm.envAddress("KYC_ATTESTER");
        KYCRegistry kyc = KYCRegistry(
            address(
                new ERC1967Proxy(address(new KYCRegistry()), abi.encodeCall(KYCRegistry.initialize, (admin, attester)))
            )
        );
        EquinoxPool pool = EquinoxPool(
            address(
                new ERC1967Proxy(
                    address(new EquinoxPool()),
                    abi.encodeCall(EquinoxPool.initialize, (admin, IERC20(dshares), IERC20(usdc), kyc, 342))
                )
            )
        );
        FHERC20Wrapper wrapper = FHERC20Wrapper(
            address(
                new ERC1967Proxy(
                    address(new FHERC20Wrapper()),
                    abi.encodeCall(FHERC20Wrapper.initialize, (admin, IERC20(dshares), "Fhenix bTSLA", "fbTSLA", 6))
                )
            )
        );
        PythOracleAdapter adapter = new PythOracleAdapter(IPyth(pyth), feedId, 60, 200); // 2% max conf

        vm.stopBroadcast();

        console.log("TimelockController", address(timelock));
        console.log("KYCRegistry       ", address(kyc));
        console.log("EquinoxPool       ", address(pool));
        console.log("FHERC20Wrapper    ", address(wrapper));
        console.log("PythOracleAdapter ", address(adapter));
        console.log("admin (timelock)  ", admin);
        console.log("NEXT: via Safe/timelock -> pool.setOracle(adapter) & seed USDC liquidity");
    }
}
