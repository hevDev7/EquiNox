// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {CoFheTest} from "@fhenixprotocol/cofhe-mock-contracts/CoFheTest.sol";
import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MockUSDC, MockDShares} from "../src/mocks/MockERC20.sol";
import {MockOracle} from "../src/mocks/MockOracle.sol";
import {KYCRegistry} from "../src/KYCRegistry.sol";
import {EquinoxPool} from "../src/EquinoxPool.sol";

/// @notice Confidential-settlement EquinoxPool (post-EQX-02 rewrite). Position values are
///         sealed; real tokens move only at the fund/withdraw edges. Borrow/repay/liquidate
///         are synchronous (no public decrypt) and operate on a sealed credit ledger.
contract EquinoxPoolTest is CoFheTest {
    MockUSDC usdc;
    MockDShares dsh;
    KYCRegistry kyc;
    EquinoxPool pool;
    MockOracle oracle;

    address user = makeAddr("user");

    uint64 constant S = 73_194_028; // secret blinding s_i
    uint64 constant PRICE = 342; // whole USD / share
    uint256 constant ATTESTER_PK = 0xA77E5715;
    address attester;

    uint256 constant WEEKDAY = 1_704_283_200; // 2024-01-03 12:00 UTC (Wed)
    uint256 constant SATURDAY = 1_704_542_400; // 2024-01-06 12:00 UTC (Sat)

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

        usdc.mint(address(pool), 1_000_000 * 1e6); // pool USDC for borrow withdrawals
        dsh.mint(user, 10_000 * 1e6);
        usdc.mint(user, 1_000_000 * 1e6);

        oracle = new MockOracle(PRICE);
        pool.setOracle(oracle); // GOVERNOR_ROLE (this)
        pool.setBorrowRate(0); // deterministic index (=1.0) for exact assertions
    }

    // ---------------------------------------------------------------- helpers

    function _attestSig(address who, uint256 expiry) internal returns (bytes memory) {
        bytes32 digest = kyc.attestationDigest(who, expiry);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function _onboard(address who, uint64 sVal) internal {
        uint256 expiry = block.timestamp + 1 days;
        bytes memory sig = _attestSig(who, expiry); // compute BEFORE prank (external calls)
        InEuint64 memory sIn = createInEuint64(sVal, who);
        vm.prank(who);
        kyc.register(expiry, sig);
        vm.prank(who);
        pool.initBlinding(sIn);
        vm.startPrank(who);
        dsh.approve(address(pool), type(uint256).max);
        usdc.approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev fund plaintext shares then move a sealed amount into collateral.
    function _fundAndDeposit(address who, uint64 shares) internal {
        vm.prank(who);
        pool.fundShares(shares);
        InEuint64 memory e = createInEuint64(shares, who);
        vm.prank(who);
        pool.deposit(e);
    }

    function _onboardAndDeposit(uint64 shares) internal {
        _onboard(user, S);
        _fundAndDeposit(user, shares);
    }

    function _poke(address who) internal {
        pool.pokeFactors(who);
    }

    /// @dev warp past the mock async-decrypt offset, then poke — borrow/deposit issue a
    ///      fresh factor decrypt that only resolves a few blocks later.
    function _settle() internal {
        vm.warp(block.timestamp + 11);
        _poke(user);
    }

    /// @dev confidential synchronous borrow.
    function _borrow(address who, uint64 amount) internal {
        InEuint64 memory r = createInEuint64(amount, who);
        vm.prank(who);
        pool.requestBorrow(r);
    }

    function _repay(address who, uint64 amount) internal {
        InEuint64 memory e = createInEuint64(amount, who);
        vm.prank(who);
        pool.repay(e);
    }

    /// @dev crash/move the price through the trusted oracle (bypasses the bounded manual
    ///      setPrice deviation cap — models a real Pyth feed move).
    function _setOraclePrice(uint64 p) internal {
        oracle.set(p);
        pool.syncPrice();
    }

    /// @dev a KYC'd liquidator funded with sealed USDC credit to repay.
    function _liquidator() internal returns (address bot) {
        bot = makeAddr("bot");
        usdc.mint(bot, 1_000_000 * 1e6);
        _onboard(bot, 42_424_242);
        vm.prank(bot);
        pool.fundUsdc(500_000); // sealed USDC credit to fund liquidations
    }

    function _liquidate(address bot, address victim, uint64 repayUsdc) internal {
        InEuint64 memory e = createInEuint64(repayUsdc, bot);
        vm.prank(bot);
        pool.liquidate(victim, e);
    }

    // ---------------------------------------------------------------- core flow

    function test_KycAndDeposit_SettlesPublicFactors() public {
        _onboardAndDeposit(1000);
        _settle();

        (uint256 a, uint256 b, bool ready) = pool.getFactors(user);
        assertTrue(ready, "factors settled");
        assertEq(a, uint256(S) * 1000 * pool.LT_BPS(), "A = s*C*LT");
        assertEq(b, 0, "B = s*D = 0 (no debt)");
        assertEq(pool.healthFactorBps(user), type(uint256).max);
        assertHashValue(pool.encryptedCollateralOf(user), uint64(1000));
        assertHashValue(pool.encryptedShareCreditOf(user), uint64(0)); // all funded shares deployed
    }

    function test_Deposit_PartialFromShareCredit() public {
        _onboard(user, S);
        vm.prank(user);
        pool.fundShares(1000); // idle credit = 1000
        InEuint64 memory e = createInEuint64(uint64(400), user);
        vm.prank(user);
        pool.deposit(e); // move 400 to collateral, 600 stays idle
        assertHashValue(pool.encryptedCollateralOf(user), uint64(400));
        assertHashValue(pool.encryptedShareCreditOf(user), uint64(600));
    }

    function test_ConfidentialBorrow_WithinLimit_CreditsSealedUsdc() public {
        _onboardAndDeposit(1000); // cap = 1000*342*0.7 = 239,400
        _settle();

        _borrow(user, 100_000);
        // proceeds are SEALED credit, not a public disbursement (EQX-02)
        assertHashValue(pool.encryptedUsdcCreditOf(user), uint64(100_000));

        _settle();
        (, uint256 b,) = pool.getFactors(user);
        assertEq(b, uint256(S) * 100_000, "B = s*D after borrow");
    }

    function test_Withdraw_RealizesSealedUsdcCredit() public {
        _onboardAndDeposit(1000);
        _settle();
        _borrow(user, 100_000);

        uint256 before = usdc.balanceOf(user);
        InEuint64 memory w = createInEuint64(uint64(60_000), user);
        vm.prank(user);
        uint256 id = pool.requestWithdraw(w, true); // isUsdc

        vm.prank(user);
        vm.expectRevert(EquinoxPool.DecryptionPending.selector);
        pool.claimWithdraw(id); // not warped

        vm.warp(block.timestamp + 11);
        vm.prank(user);
        pool.claimWithdraw(id);
        assertEq(usdc.balanceOf(user) - before, 60_000 * 1e6, "withdrew 60k real USDC");
        assertHashValue(pool.encryptedUsdcCreditOf(user), uint64(40_000)); // 100k - 60k
    }

    function test_WithdrawShares_ReturnsIdleCredit() public {
        _onboard(user, S);
        vm.prank(user);
        pool.fundShares(1000); // idle 1000, none deposited as collateral
        uint256 before = dsh.balanceOf(user);
        InEuint64 memory w = createInEuint64(uint64(400), user);
        vm.prank(user);
        uint256 id = pool.requestWithdraw(w, false); // shares
        vm.warp(block.timestamp + 11);
        vm.prank(user);
        pool.claimWithdraw(id);
        assertEq(dsh.balanceOf(user) - before, 400 * 1e6, "withdrew 400 real dShares");
        assertHashValue(pool.encryptedShareCreditOf(user), uint64(600));
    }

    function test_ConfidentialBorrow_OverLimit_DrawsZero_NoRevert() public {
        _onboardAndDeposit(1000); // cap = 239,400
        _settle();
        _borrow(user, 10_000_000); // way over -> FHE.select draws 0, no revert
        assertHashValue(pool.encryptedUsdcCreditOf(user), uint64(0));
    }

    // ----------------------------------------------------- EQX-01 (the headline)

    /// @notice AUDIT EQX-01 regression: the borrow gate subtracts outstanding debt, so the
    ///         sum of borrows can never exceed the collateral's LTV capacity. Pre-fix the
    ///         pool could be drained ~2.8x (PoC_UnlimitedBorrow).
    function test_EQX01_BorrowGate_SubtractsOutstandingDebt() public {
        _onboardAndDeposit(1000); // cap = 239,400 USDC
        _settle();

        _borrow(user, 239_400); // exactly the cap, no prior debt -> approved
        assertHashValue(pool.encryptedUsdcCreditOf(user), uint64(239_400));

        // a SECOND full-cap borrow now has zero remaining room -> draws 0
        _borrow(user, 239_400);
        assertHashValue(pool.encryptedUsdcCreditOf(user), uint64(239_400)); // unchanged

        // even a 1-unit borrow draws 0 once the position is at the LTV ceiling
        _borrow(user, 1);
        assertHashValue(pool.encryptedUsdcCreditOf(user), uint64(239_400));
    }

    function test_EQX01_PartialFill_RespectsRemainingRoom() public {
        _onboardAndDeposit(1000); // cap 239,400
        _settle();
        _borrow(user, 100_000); // room 239,400 -> ok
        _borrow(user, 139_400); // remaining room exactly 139,400 -> ok (total = cap)
        assertHashValue(pool.encryptedUsdcCreditOf(user), uint64(239_400));
        _borrow(user, 1); // no room left -> 0
        assertHashValue(pool.encryptedUsdcCreditOf(user), uint64(239_400));
    }

    // --------------------------------------------------------------- repay

    function test_Repay_ReducesSealedDebtFromCredit() public {
        _onboardAndDeposit(1000);
        _settle();
        _borrow(user, 150_000); // debt 150k, credit 150k
        _repay(user, 50_000); // repay 50k from credit
        assertHashValue(pool.encryptedScaledDebtOf(user), uint64(100_000));
        assertHashValue(pool.encryptedUsdcCreditOf(user), uint64(100_000));
    }

    function test_Repay_ClampedToDebt_NoOverpaymentBurn() public {
        _onboardAndDeposit(1000);
        _settle();
        _borrow(user, 50_000); // debt 50k, credit 50k
        pool.setBorrowRate(0);
        _repay(user, 50_000); // try to repay full credit; debt only 50k
        assertHashValue(pool.encryptedScaledDebtOf(user), uint64(0));
        // index == 1.0 so exactly 50k consumed, nothing left over to burn
        assertHashValue(pool.encryptedUsdcCreditOf(user), uint64(0));
    }

    // ------------------------------------------------- weekend / interest / oracle

    function test_WeekendCircuitBreaker_PausesBorrow() public {
        _onboardAndDeposit(1000);
        _settle();
        vm.warp(SATURDAY);
        _setOraclePrice(PRICE); // refresh oracle on the weekend timestamp
        assertTrue(pool.isWeekendMode(), "weekend active");
        InEuint64 memory r = createInEuint64(uint64(1000), user);
        vm.prank(user);
        vm.expectRevert(EquinoxPool.WeekendBreaker.selector);
        pool.requestBorrow(r);
    }

    function test_Borrow_RevertsOnStaleOracle() public {
        _onboardAndDeposit(1000);
        _settle();
        vm.warp(block.timestamp + 61); // oracle > 60s old, still a weekday
        InEuint64 memory r = createInEuint64(uint64(1000), user);
        vm.prank(user);
        vm.expectRevert(EquinoxPool.StaleOracle.selector);
        pool.requestBorrow(r);
    }

    function test_InterestAccrual_GrowsDebt_LowersHealth() public {
        _onboardAndDeposit(1000);
        _settle();
        _borrow(user, 150_000);
        _settle();

        pool.setBorrowRate(480); // 4.8%/yr
        uint256 idx0 = pool.currentIndexBps();
        uint256 hf0 = pool.healthFactorBps(user);
        vm.warp(block.timestamp + 730 days);
        assertGt(pool.currentIndexBps(), idx0, "index accrued");
        assertLt(pool.healthFactorBps(user), hf0, "health worsened from interest");
    }

    // ------------------------------------------------------------ liquidation

    function test_Liquidation_Confidential_RepaysAndSeizes() public {
        _onboardAndDeposit(1000);
        _settle();
        _borrow(user, 150_000);
        _settle();

        _setOraclePrice(100); // crash -> unhealthy
        assertLt(pool.healthFactorBps(user), pool.BPS(), "HF < 1.0");

        address bot = _liquidator();
        _liquidate(bot, user, 50_000); // CF cap = 75k; seize = 50000*1.075/100 = 537

        assertTrue(pool.liquidated(user), "liquidated");
        assertHashValue(pool.encryptedScaledDebtOf(user), uint64(100_000));
        assertHashValue(pool.encryptedCollateralOf(user), uint64(463));
        assertHashValue(pool.encryptedCollateralOf(bot), uint64(537));
        // liquidator's sealed USDC credit dropped by exactly the (capped) repay
        assertHashValue(pool.encryptedUsdcCreditOf(bot), uint64(500_000 - 50_000));
    }

    function test_HealthyCannotBeLiquidated() public {
        _onboardAndDeposit(1000);
        _settle();
        _borrow(user, 10_000); // tiny debt -> very healthy
        _settle();
        assertGe(pool.healthFactorBps(user), pool.BPS(), "healthy");
        address bot = _liquidator();
        InEuint64 memory e = createInEuint64(uint64(5_000), bot);
        vm.prank(bot);
        vm.expectRevert(EquinoxPool.Healthy.selector);
        pool.liquidate(user, e);
    }

    function test_ZeroBlinding_Clamped_StillLiquidatable() public {
        _onboard(user, 0); // malicious s=0 attempt -> clamped to >=1
        _fundAndDeposit(user, 1000);
        _borrow(user, 150_000);
        _settle();
        (uint256 a, uint256 b,) = pool.getFactors(user);
        assertGt(a, 0, "A>0 despite s=0");
        assertGt(b, 0, "B>0 despite s=0");
        _setOraclePrice(100);
        assertLt(pool.healthFactorBps(user), pool.BPS(), "still liquidatable");
        address bot = _liquidator();
        _liquidate(bot, user, 10_000);
        assertTrue(pool.liquidated(user), "liquidated despite s=0");
    }

    /// forge-config: default.fuzz.runs = 16
    function testFuzz_SeizeBoundedByCollateral(uint64 repay) public {
        repay = uint64(bound(repay, 1, 200_000));
        _onboardAndDeposit(1000);
        _settle();
        _borrow(user, 150_000);
        _settle();
        _setOraclePrice(100); // crash

        address bot = _liquidator();
        _liquidate(bot, user, repay);

        uint256 pay = repay > 75_000 ? 75_000 : repay; // close-factor cap = 75k
        uint256 seize = (pay * (uint256(pool.BPS()) + pool.LIQ_BONUS_BPS())) / (uint256(pool.BPS()) * 100);
        uint64 expectColl = seize >= 1000 ? 0 : uint64(1000 - seize);
        assertHashValue(pool.encryptedCollateralOf(user), expectColl);
    }

    // ----------------------------------------------------- EQX-03 staleness guard

    function test_EQX03_Liquidate_RevertsOnStaleOracle() public {
        _onboardAndDeposit(1000);
        _settle();
        _borrow(user, 150_000);
        _settle();
        _setOraclePrice(100); // crash -> unhealthy, fresh
        address bot = _liquidator();

        vm.warp(block.timestamp + 61); // price now stale
        InEuint64 memory e = createInEuint64(uint64(50_000), bot);
        vm.prank(bot);
        vm.expectRevert(EquinoxPool.StaleOracle.selector);
        pool.liquidate(user, e);
    }

    // ----------------------------------- EQX-04 liquidation cannot be self-DoS'd

    /// @notice AUDIT EQX-04: a borrower spamming cheap state changes (which reset the
    ///         factorsReady flag) can no longer block their own liquidation — eligibility
    ///         uses the last *settled* factors, not the resettable flag.
    function test_EQX04_BorrowerCannotBlockOwnLiquidation() public {
        _onboardAndDeposit(1000);
        _settle();
        _borrow(user, 150_000);
        _settle(); // last-settled factors reflect the 150k debt
        _setOraclePrice(100); // crash -> unhealthy

        // borrower tries to dodge: fund + deposit 1 share to invalidate factorsReady
        vm.prank(user);
        pool.fundShares(1);
        InEuint64 memory d = createInEuint64(uint64(1), user);
        vm.prank(user);
        pool.deposit(d); // _recomputeFactors -> factorsReady = false, NOT poked
        (,, bool ready) = pool.getFactors(user);
        assertFalse(ready, "latest factors intentionally left unsettled by attacker");

        // liquidation still proceeds off the last-settled factors
        address bot = _liquidator();
        _liquidate(bot, user, 50_000);
        assertTrue(pool.liquidated(user), "liquidation NOT blocked by factor invalidation");
    }

    // ------------------------------------ EQX-05 victim keeps decrypt-ACL post-liq

    function test_EQX05_Liquidation_VictimRetainsDecryptAcl() public {
        _onboardAndDeposit(1000);
        _settle();
        _borrow(user, 150_000);
        _settle();
        _setOraclePrice(100);
        address bot = _liquidator();
        _liquidate(bot, user, 50_000);

        uint256 collHandle = euint64.unwrap(pool.encryptedCollateralOf(user));
        uint256 debtHandle = euint64.unwrap(pool.encryptedScaledDebtOf(user));
        assertTrue(acl.isAllowed(collHandle, user), "victim keeps collateral decrypt-ACL");
        assertTrue(acl.isAllowed(debtHandle, user), "victim keeps debt decrypt-ACL");
        // liquidator keeps ACL on their seized collateral (control)
        assertTrue(acl.isAllowed(euint64.unwrap(pool.encryptedCollateralOf(bot)), bot), "liquidator ACL");
    }

    // --------------------------------- EQX-06 no silent overflow at large collateral

    /// @notice AUDIT EQX-06: euint128 intermediates keep C·price·LTV from wrapping. With a
    ///         large collateral the borrow cap is still computed correctly (not a wrapped
    ///         small/large value).
    function test_EQX06_LargeCollateral_NoOverflow() public {
        _onboard(user, S);
        uint64 big = 1_000_000_000; // 1e9 shares; pre-fix C*price*LTV overflows euint64
        dsh.mint(user, uint256(big) * 1e6);
        vm.prank(user);
        pool.fundShares(big);
        InEuint64 memory dep = createInEuint64(big, user);
        vm.prank(user);
        pool.deposit(dep);
        _settle();

        // cap = big*342*0.7 = 239,400,000,000; borrowing just over it draws 0, just under is ok
        uint64 underCap = 200_000_000_000; // < cap
        _borrow(user, underCap);
        assertHashValue(pool.encryptedUsdcCreditOf(user), underCap); // correct, not wrapped
    }

    // ----------------------------------------------- EQX-07 setPrice bounds

    function test_EQX07_SetPrice_RevertsOnZero() public {
        vm.expectRevert(EquinoxPool.PriceOutOfBounds.selector);
        pool.setPrice(0);
    }

    function test_EQX07_SetPrice_RevertsAboveMax() public {
        vm.expectRevert(EquinoxPool.PriceOutOfBounds.selector);
        pool.setPrice(2_000_000); // > MAX_PRICE
    }

    function test_EQX07_SetPrice_RevertsOnDeviationSpike() public {
        // current price 342; a >20% jump is rejected by the manual setter
        vm.expectRevert(EquinoxPool.PriceDeviationTooHigh.selector);
        pool.setPrice(500); // +46%
    }

    function test_EQX07_SetPrice_AllowsSmallMove() public {
        pool.setPrice(360); // +5.2% within the 20% cap
        assertEq(pool.price(), 360);
    }

    // ----------------------------------------------------- access / revert coverage

    function test_Borrow_RevertsWithoutKyc() public {
        address stranger = makeAddr("stranger");
        InEuint64 memory r = createInEuint64(uint64(1), stranger);
        vm.prank(stranger);
        vm.expectRevert(EquinoxPool.KycRequired.selector);
        pool.requestBorrow(r);
    }

    function test_Pause_BlocksFundShares() public {
        _onboard(user, S);
        pool.pause();
        vm.prank(user);
        vm.expectRevert();
        pool.fundShares(1000);
    }

    function _kycOnly(address who) internal {
        uint256 expiry = block.timestamp + 1 days;
        bytes memory sig = _attestSig(who, expiry);
        vm.prank(who);
        kyc.register(expiry, sig);
    }

    function test_FundShares_RevertsBeforeBlinding() public {
        _kycOnly(user);
        vm.prank(user);
        vm.expectRevert(EquinoxPool.NotInitialized.selector);
        pool.fundShares(1000);
    }

    function test_InitBlinding_RevertsIfTwice() public {
        _onboard(user, S);
        InEuint64 memory sIn = createInEuint64(S, user);
        vm.prank(user);
        vm.expectRevert(EquinoxPool.AlreadyInitialized.selector);
        pool.initBlinding(sIn);
    }

    function test_FundShares_RevertsOnZeroAmount() public {
        _onboard(user, S);
        vm.prank(user);
        vm.expectRevert(EquinoxPool.BadAmount.selector);
        pool.fundShares(0);
    }

    function test_FundShares_RevertsOnTooLarge() public {
        _onboard(user, S);
        vm.prank(user);
        vm.expectRevert(EquinoxPool.BadAmount.selector);
        pool.fundShares(uint256(type(uint64).max) + 1);
    }

    function test_HealthFactor_RevertsBeforeSettle() public {
        _onboardAndDeposit(1000); // factors recomputed but never poked
        vm.expectRevert(EquinoxPool.FactorsNotSettled.selector);
        pool.healthFactorBps(user);
    }

    function test_Liquidate_RevertsIfVictimNeverSettled() public {
        _onboardAndDeposit(1000); // never poked -> factorsSettledOnce == false
        address bot = _liquidator();
        InEuint64 memory e = createInEuint64(uint64(50_000), bot);
        vm.prank(bot);
        vm.expectRevert(EquinoxPool.FactorsNotSettled.selector);
        pool.liquidate(user, e);
    }

    function test_Liquidate_RevertsIfLiquidatorNotInitialized() public {
        _onboardAndDeposit(1000);
        _settle();
        address liq = makeAddr("liqUninit");
        _kycOnly(liq); // KYC'd but never initBlinding
        InEuint64 memory e = createInEuint64(uint64(50_000), liq);
        vm.prank(liq);
        vm.expectRevert(EquinoxPool.NotInitialized.selector);
        pool.liquidate(user, e);
    }

    function test_ClaimWithdraw_RevertsForNonOwner() public {
        _onboardAndDeposit(1000);
        _settle();
        _borrow(user, 100_000);
        InEuint64 memory w = createInEuint64(uint64(50_000), user);
        vm.prank(user);
        uint256 id = pool.requestWithdraw(w, true);
        vm.warp(block.timestamp + 11);
        vm.prank(makeAddr("stranger2"));
        vm.expectRevert(EquinoxPool.NotOwner.selector);
        pool.claimWithdraw(id);
    }

    function test_SyncPrice_RevertsWithoutOracle() public {
        // fresh pool with no oracle wired
        EquinoxPool p2 = EquinoxPool(
            address(
                new ERC1967Proxy(
                    address(new EquinoxPool()),
                    abi.encodeCall(
                        EquinoxPool.initialize, (address(this), IERC20(address(dsh)), IERC20(address(usdc)), kyc, PRICE)
                    )
                )
            )
        );
        vm.expectRevert(EquinoxPool.NoOracle.selector);
        p2.syncPrice();
    }

    function test_HealthFactor_WeekendHaircut() public {
        _onboardAndDeposit(1000);
        _settle();
        _borrow(user, 100_000);
        _settle();
        uint256 hfWeekday = pool.healthFactorBps(user);
        vm.warp(1_704_490_200); // Friday night -> weekend haircut
        uint256 hfWeekend = pool.healthFactorBps(user);
        assertLt(hfWeekend, hfWeekday, "15% haircut lowers HF on weekend");
    }

    function test_IsWeekendMode_Boundaries() public {
        vm.warp(1_704_628_800);
        assertTrue(pool.isWeekendMode(), "Sunday");
        vm.warp(1_704_490_200);
        assertTrue(pool.isWeekendMode(), "Fri after 21:00");
        vm.warp(1_704_466_800);
        assertFalse(pool.isWeekendMode(), "Fri before 21:00");
        vm.warp(1_704_715_200);
        assertTrue(pool.isWeekendMode(), "Mon before 13:30");
        vm.warp(1_704_720_600);
        assertFalse(pool.isWeekendMode(), "Mon at 13:30");
        vm.warp(WEEKDAY);
        assertFalse(pool.isWeekendMode(), "Wed midday");
    }
}
