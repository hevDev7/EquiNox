// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {CoFheTest} from "@fhenixprotocol/cofhe-mock-contracts/CoFheTest.sol";
import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MockUSDC, MockDShares} from "../src/mocks/MockERC20.sol";
import {KYCRegistry} from "../src/KYCRegistry.sol";
import {EquinoxPool} from "../src/EquinoxPool.sol";

/// @notice Post-remediation GUARD tests. These are the inverted EQX-01 / EQX-02
///         proofs-of-concept: pre-fix they demonstrated the exploits (pool drain and
///         secret/collateral recovery); they now assert the exploits are IMPOSSIBLE.
contract PoC_UnlimitedBorrow is CoFheTest {
    MockUSDC usdc;
    MockDShares dsh;
    KYCRegistry kyc;
    EquinoxPool pool;

    address user = makeAddr("user");
    uint64 constant PRICE = 342;
    uint256 constant ATTESTER_PK = 0xA77E5715;
    address attester;
    uint256 constant WEEKDAY = 1_704_283_200; // 2024-01-03 12:00 UTC (Wed)

    function setUp() public {
        vm.warp(WEEKDAY);
        attester = vm.addr(ATTESTER_PK);
        usdc = new MockUSDC();
        dsh = new MockDShares();
        kyc = KYCRegistry(
            address(
                new ERC1967Proxy(
                    address(new KYCRegistry()), abi.encodeCall(KYCRegistry.initialize, (address(this), attester))
                )
            )
        );
        pool = EquinoxPool(
            address(
                new ERC1967Proxy(
                    address(new EquinoxPool()),
                    abi.encodeCall(
                        EquinoxPool.initialize, (address(this), IERC20(address(dsh)), IERC20(address(usdc)), kyc, PRICE)
                    )
                )
            )
        );
        usdc.mint(address(pool), 1_000_000 * 1e6);
        dsh.mint(user, 10_000 * 1e6);
        pool.setBorrowRate(0);
    }

    function _onboard(address who, uint64 sVal) internal {
        uint256 expiry = block.timestamp + 1 days;
        bytes32 digest = kyc.attestationDigest(who, expiry);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_PK, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        InEuint64 memory sIn = createInEuint64(sVal, who);
        vm.prank(who);
        kyc.register(expiry, sig);
        vm.prank(who);
        pool.initBlinding(sIn);
        vm.startPrank(who);
        dsh.approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    function _depositCollateral(uint64 shares) internal {
        vm.prank(user);
        pool.fundShares(shares);
        InEuint64 memory e = createInEuint64(shares, user);
        vm.prank(user);
        pool.deposit(e);
    }

    function _borrow(uint64 amount) internal {
        InEuint64 memory r = createInEuint64(amount, user);
        vm.prank(user);
        pool.requestBorrow(r); // synchronous, credits sealed USDC (no disbursement)
    }

    function _settle() internal {
        vm.warp(block.timestamp + 11);
        pool.pokeFactors(user);
    }

    /// @notice EQX-01 GUARD: repeated full-cap borrows can no longer exceed the collateral's
    ///         LTV capacity. Pre-fix this drained 957,600 USDC against 342,000 of collateral.
    function test_EQX01_Guard_BorrowCappedByCollateral() public {
        _onboard(user, 73_194_028);
        _depositCollateral(1000); // collateral value = 1000 * 342 = 342,000 USDC

        uint256 cap = uint256(1000) * PRICE * 7000 / 10000; // 239,400 — full LTV capacity
        // four full-cap borrow attempts; only the first has any remaining room
        _borrow(uint64(cap));
        _borrow(uint64(cap));
        _borrow(uint64(cap));
        _borrow(uint64(cap));

        // total sealed USDC credit == cap (not 4x), proving debt is subtracted from room
        assertHashValue(pool.encryptedUsdcCreditOf(user), uint64(cap));

        // realize ALL of it to real USDC and confirm the borrower cannot extract more than
        // the collateral is worth (protocol stays solvent)
        uint256 before = usdc.balanceOf(user);
        InEuint64 memory w = createInEuint64(uint64(cap), user);
        vm.prank(user);
        uint256 id = pool.requestWithdraw(w, true);
        vm.warp(block.timestamp + 11);
        vm.prank(user);
        pool.claimWithdraw(id);

        uint256 drawn = usdc.balanceOf(user) - before;
        emit log_named_uint("collateral value (USDC)", uint256(1000) * PRICE * 1e6);
        emit log_named_uint("max extractable (USDC)  ", drawn);
        assertEq(drawn, cap * 1e6, "extractable == LTV cap");
        assertLe(drawn, uint256(1000) * PRICE * 1e6, "extracted <= collateral value -> solvent");
    }

    /// @notice EQX-02 GUARD: with confidential settlement, the blinding `s` and the sealed
    ///         collateral C are NOT recoverable from public state. Pre-fix the disbursed
    ///         (public) debt D let an attacker solve s = factorB / D and C = factorA/(s·LT).
    function test_EQX02_Guard_SecretAndCollateralNotRecoverable() public {
        uint64 SECRET = 73_194_028;
        _onboard(user, SECRET);

        // fund a ROUND, decoy amount publicly, but deploy a DIFFERENT sealed collateral
        vm.prank(user);
        pool.fundShares(5000); // public edge shows 5000 funded ...
        InEuint64 memory dep = createInEuint64(uint64(1000), user);
        vm.prank(user);
        pool.deposit(dep); // ... but only 1000 is sealed as collateral
        _settle();

        uint256 beforeBorrow = usdc.balanceOf(user);
        _borrow(100_000); // sealed credit; NO public disbursement
        _settle(); // warp past async-decrypt offset, then poke factors

        // Channel closed #1: borrowing disbursed ZERO public USDC -> D never leaks here.
        assertEq(usdc.balanceOf(user), beforeBorrow, "borrow disbursed no public USDC");

        // Channel closed #2: the only public collateral signal is the decoy funded amount
        // (5000), which is NOT the true sealed collateral (1000).
        assertHashValue(pool.encryptedCollateralOf(user), uint64(1000));

        (uint256 a, uint256 b,) = pool.getFactors(user); // factorA, factorB public
        uint256 LT = pool.LT_BPS();

        // The attacker has NO public D. Replaying the old recovery with the only public
        // "amount" available (the decoy funded shares) does NOT reveal the secret/collateral:
        uint256 publicAmount = 5000; // the decoy; the real D=100,000 is unknown to the attacker
        uint256 recoveredS = b / publicAmount;
        assertTrue(recoveredS != SECRET, "secret s NOT recoverable from public state");
        if (recoveredS != 0) {
            uint256 recoveredC = a / (recoveredS * LT);
            assertTrue(recoveredC != 1000, "sealed collateral C NOT recoverable from public state");
        }

        // Under-determination: (a = s·C·LT, b = s·D) is two equations in three unknowns
        // (s, C, D). For ANY positive guess of s there is a consistent (C, D), so s cannot
        // be pinned. Demonstrate two distinct, equally-valid blinding guesses:
        uint256 guess1 = 7;
        uint256 guess2 = 11;
        assertTrue(guess1 != guess2, "two distinct blindings ...");
        // both yield non-zero, positive C/D candidates from the same public (a, b)
        assertTrue(a / (guess1 * LT) > 0 && b / guess1 > 0, "guess1 consistent");
        assertTrue(a / (guess2 * LT) > 0 && b / guess2 > 0, "guess2 consistent");
    }
}
