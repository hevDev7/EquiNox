// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MockDShares} from "../src/mocks/MockERC20.sol";
import {KYCRegistry} from "../src/KYCRegistry.sol";
import {EquinoxPool} from "../src/EquinoxPool.sol";
import {FHERC20Wrapper} from "../src/FHERC20Wrapper.sol";

/// @notice Deploys the Equinox stack behind UUPS (ERC1967) proxies.
///   `GOVERNANCE` (env) becomes the admin / role holder — pass a
///   TimelockController (multisig-controlled) address in production.
///
///   forge script script/Deploy.s.sol:Deploy \
///     --rpc-url $ARBITRUM_SEPOLIA_RPC --broadcast --private-key $PK
///
/// @dev  AUDIT EQX-07 — ⚠️ NON-PRODUCTION / TESTNET & LOCAL DEMO ONLY. When
///       `GOVERNANCE` is unset this grants DEFAULT_ADMIN + GOVERNOR + ORACLE_MANAGER
///       + PAUSER + UPGRADER all to a single deploying EOA (one hot key = full
///       custody, and an unbounded `setPrice` oracle). Deploys MockUSDC/MockDShares
///       with an open faucet. For any public/persistent deployment use
///       `DeployProduction.s.sol`, which routes every role through a
///       TimelockController + multisig and wires the guarded Pyth oracle adapter.
contract Deploy is Script {
    uint64 constant INITIAL_PRICE = 342; // whole USD / share
    /// @dev Official Circle USDC on Arbitrum Sepolia (verified: symbol=USDC, decimals=6). Override via env USDC for local anvil.
    address constant USDC_ARBITRUM_SEPOLIA = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;

    function run() external {
        address admin = vm.envOr("GOVERNANCE", msg.sender);
        address attester = vm.envOr("KYC_ATTESTER", admin);
        console.log("WARNING: Deploy.s.sol is TESTNET/DEMO ONLY - single-key admin & open faucets.");
        console.log("WARNING: use DeployProduction.s.sol (timelock+multisig) for public networks.");
        vm.startBroadcast();

        address usdc = vm.envOr("USDC", USDC_ARBITRUM_SEPOLIA); // real Circle USDC by default
        MockDShares dsh = new MockDShares();

        KYCRegistry kyc = KYCRegistry(
            address(
                new ERC1967Proxy(address(new KYCRegistry()), abi.encodeCall(KYCRegistry.initialize, (admin, attester)))
            )
        );

        EquinoxPool pool = EquinoxPool(
            address(
                new ERC1967Proxy(
                    address(new EquinoxPool()),
                    abi.encodeCall(
                        EquinoxPool.initialize, (admin, IERC20(address(dsh)), IERC20(usdc), kyc, INITIAL_PRICE)
                    )
                )
            )
        );

        FHERC20Wrapper wrapper = FHERC20Wrapper(
            address(
                new ERC1967Proxy(
                    address(new FHERC20Wrapper()),
                    abi.encodeCall(
                        FHERC20Wrapper.initialize, (admin, IERC20(address(dsh)), "Fhenix bTSLA", "fbTSLA", 6)
                    )
                )
            )
        );

        vm.stopBroadcast();

        console.log("USDC (Circle)   ", usdc);
        console.log("  -> fund the pool with USDC (faucet.circle.com) at", address(pool));
        console.log("MockDShares     ", address(dsh));
        console.log("KYCRegistry     ", address(kyc));
        console.log("EquinoxPool     ", address(pool));
        console.log("FHERC20Wrapper  ", address(wrapper));
        console.log("admin/governance", admin);
    }
}
