// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {CofheTest} from "@cofhe/foundry-plugin/contracts/CofheTest.sol";
import {CofheClient} from "@cofhe/foundry-plugin/contracts/CofheClient.sol";
import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC, MockStock} from "../src/mocks/MockERC20.sol";
import {KYCRegistry} from "../src/KYCRegistry.sol";
import {EquinoxPoolV2} from "../src/EquinoxPoolV2.sol";

/// @notice Batch D / AUDIT #1 — V2 multi-collateral FHE unit tests on the OFFICIAL Fhenix
///         Foundry harness (cofhe foundry-plugin CofheTest: deploys the 0.5.2 mock CoFHE
///         stack; CofheClient.createInEuint64; expectPlaintext). Proves the confidential
///         aggregation D3 proved on-chain — now as a fast, deterministic unit test.
contract PoolV2FheTest is CofheTest {
    MockUSDC usdc;
    MockStock tsla;
    MockStock aapl;
    KYCRegistry kyc;
    EquinoxPoolV2 pool;
    CofheClient client;

    address admin = makeAddr("admin");
    uint256 attesterPk = 0xA77E5715;
    address attester;
    uint256 userPk = 0xB0B5;
    address user;

    function setUp() public {
        deployMocks(); // etch the mock CoFHE stack at canonical addresses
        client = createCofheClient();
        client.connect(userPk); // bind encrypted inputs to `user`

        attester = vm.addr(attesterPk);
        user = vm.addr(userPk);

        usdc = new MockUSDC();
        tsla = new MockStock("dTSLA", "dTSLA");
        aapl = new MockStock("dAAPL", "dAAPL");

        KYCRegistry kycImpl = new KYCRegistry();
        kyc = KYCRegistry(
            address(new ERC1967Proxy(address(kycImpl), abi.encodeCall(KYCRegistry.initialize, (admin, attester))))
        );

        EquinoxPoolV2 impl = new EquinoxPoolV2();
        pool = EquinoxPoolV2(
            address(
                new ERC1967Proxy(
                    address(impl), abi.encodeCall(EquinoxPoolV2.initialize, (admin, IERC20(address(usdc)), kyc))
                )
            )
        );

        vm.startPrank(admin);
        pool.addAsset(IERC20(address(tsla)), 342, 7000, 8000, 750, 0, 6); // asset 0: dTSLA
        pool.addAsset(IERC20(address(aapl)), 214, 7000, 8000, 750, 0, 6); // asset 1: dAAPL
        pool.setWeekendOverride(true); // testnet bypass so borrow works any day
        vm.stopPrank();

        _registerKyc(user);
        tsla.mint(user, 1000 * 1e6);
        aapl.mint(user, 1000 * 1e6);
        vm.startPrank(user);
        tsla.approve(address(pool), type(uint256).max);
        aapl.approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    function _registerKyc(address u) internal {
        uint256 expiry = block.timestamp + 1 days;
        // attestationDigest already returns the EIP-191 eth-signed hash
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPk, kyc.attestationDigest(u, expiry));
        vm.prank(u);
        kyc.register(expiry, abi.encodePacked(r, s, v));
    }

    function _depositBoth(uint64 a0, uint64 a1) internal {
        // create the encrypted inputs (bound to `user` via the client) BEFORE pranking
        InEuint64 memory s = client.createInEuint64(73_194_028);
        InEuint64 memory d0 = client.createInEuint64(a0);
        InEuint64 memory d1 = client.createInEuint64(a1);
        vm.startPrank(user);
        pool.initBlinding(s);
        pool.fundShares(0, a0);
        pool.deposit(0, d0);
        pool.fundShares(1, a1);
        pool.deposit(1, d1);
        vm.stopPrank();
    }

    /// @notice Sealed collateral is stored per-asset and decrypts to the deposited amount.
    function test_deposit_sealsMultiAssetCollateral() public {
        _depositBoth(10, 10);
        expectPlaintext(pool.encryptedCollateralOf(user, 0), uint64(10));
        expectPlaintext(pool.encryptedCollateralOf(user, 1), uint64(10));
    }

    /// @notice Borrow capacity AGGREGATES across both sealed collaterals. dTSLA-only cap =
    ///         10*342*0.7 = 2394; combined = +10*214*0.7 = 3892. Borrowing 3000 only succeeds
    ///         (FHE.select draws the full 3000) if BOTH assets count — single-asset draws 0.
    function test_borrow_aggregatesAcrossAssets() public {
        _depositBoth(10, 10);
        InEuint64 memory r = client.createInEuint64(3000);
        vm.prank(user);
        pool.requestBorrow(r);
        // sealed USDC credit == 3000 proves the multi-asset aggregation (would be 0 if single-asset)
        expectPlaintext(pool.encryptedUsdcCreditOf(user), uint64(3000));
    }

    /// @notice Over the COMBINED cap still clamps to 0 (no revert) — confidential gating holds.
    function test_borrow_overCombinedCap_drawsZero() public {
        _depositBoth(10, 10); // combined cap 3892
        InEuint64 memory r = client.createInEuint64(5000); // > 3892
        vm.prank(user);
        pool.requestBorrow(r);
        expectPlaintext(pool.encryptedUsdcCreditOf(user), uint64(0));
    }

    /// @notice withdrawCollateral with NO debt frees the full requested amount (gate wide open).
    function test_withdrawCollateral_noDebt_full() public {
        _depositBoth(10, 10);
        InEuint64 memory w = client.createInEuint64(4);
        vm.prank(user);
        pool.withdrawCollateral(0, w);
        expectPlaintext(pool.encryptedCollateralOf(user, 0), uint64(6)); // 10 − 4 freed
        expectPlaintext(pool.encryptedCollateralOf(user, 1), uint64(10)); // other asset untouched
    }

    /// @notice With debt, a withdrawal WITHIN free capacity succeeds. Combined cap 3892, borrow
    ///         1000 → LTV room 2892; withdraw 5 dTSLA (LTV value 5*342*0.7=1197 ≤ 2892) → frees 5.
    function test_withdrawCollateral_withinCapacity() public {
        _depositBoth(10, 10);
        InEuint64 memory r = client.createInEuint64(1000);
        vm.prank(user);
        pool.requestBorrow(r);
        InEuint64 memory w = client.createInEuint64(5);
        vm.prank(user);
        pool.withdrawCollateral(0, w);
        expectPlaintext(pool.encryptedCollateralOf(user, 0), uint64(5)); // 10 − 5 freed
    }

    /// @notice A withdrawal that would breach health draws 0 (PRD parity with borrow). Combined
    ///         cap 3892, borrow 3800 → LTV room 92; withdraw 1 dTSLA (LTV value 239 > 92) → 0.
    function test_withdrawCollateral_overCapacity_drawsZero() public {
        _depositBoth(10, 10);
        InEuint64 memory r = client.createInEuint64(3800);
        vm.prank(user);
        pool.requestBorrow(r);
        InEuint64 memory w = client.createInEuint64(1);
        vm.prank(user);
        pool.withdrawCollateral(0, w);
        expectPlaintext(pool.encryptedCollateralOf(user, 0), uint64(10)); // unchanged — drew 0
    }

    /// @notice Weekend mode blocks collateral withdrawal (it's a leverage increase, and the LTV
    ///         gate ignores the weekend haircut applied to liquidation HF). Mirrors requestBorrow.
    function test_withdrawCollateral_blockedOnWeekend() public {
        _depositBoth(10, 10);
        InEuint64 memory w = client.createInEuint64(1);
        vm.prank(admin);
        pool.setWeekendOverride(false); // drop the testnet bypass
        vm.warp(2 * 86_400 + 1); // epochDays=2 → dow=(2+4)%7=6 (Saturday) → isWeekendMode()
        assertTrue(pool.isWeekendMode());
        vm.prank(user);
        vm.expectRevert(EquinoxPoolV2.WeekendBreaker.selector);
        pool.withdrawCollateral(0, w);
    }
}
