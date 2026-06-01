// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {CoFheTest} from "@fhenixprotocol/cofhe-mock-contracts/CoFheTest.sol";
import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MockUSDC, MockDShares} from "../src/mocks/MockERC20.sol";
import {KYCRegistry} from "../src/KYCRegistry.sol";
import {EquinoxPool} from "../src/EquinoxPool.sol";
import {ORACLE_MANAGER_ROLE} from "../src/access/EquinoxRoles.sol";

/// @notice Invariant handler for the confidential-settlement pool. Drives the pool with
///         fuzzed plaintext turned into encrypted inputs, while maintaining a plaintext
///         "ghost" ledger. The borrow index is frozen (rate 0) so ghost math is exact.
contract PoolHandler is CoFheTest {
    EquinoxPool internal pool;
    MockDShares internal dsh;
    MockUSDC internal usdc;
    address public actor;

    uint64 constant PRICE = 342;
    uint256 constant WEEKDAY = 1_704_283_200;

    uint256 public ghostCollateral; // shares deployed as collateral
    uint256 public ghostScaledDebt; // index == 1.0 => scaled == nominal USDC
    uint256 public ghostUsdcCredit; // sealed USDC credit (borrow proceeds)

    constructor(EquinoxPool _pool, MockDShares _dsh, MockUSDC _usdc, address _actor) {
        pool = _pool;
        dsh = _dsh;
        usdc = _usdc;
        actor = _actor;
    }

    function deposit(uint64 amt) public {
        amt = uint64(bound(amt, 1, 500));
        dsh.mint(actor, uint256(amt) * 1e6);
        vm.startPrank(actor);
        dsh.approve(address(pool), type(uint256).max);
        pool.fundShares(amt);
        vm.stopPrank();
        InEuint64 memory e = createInEuint64(amt, actor);
        vm.prank(actor);
        pool.deposit(e); // moves the freshly funded amt into collateral
        ghostCollateral += amt;
    }

    function borrow(uint64 amt) public {
        amt = uint64(bound(amt, 1, 1000));
        vm.warp(WEEKDAY); // weekday + fresh oracle window
        pool.setPrice(PRICE); // handler holds ORACLE_MANAGER_ROLE (0% deviation, in-bounds)
        InEuint64 memory r = createInEuint64(amt, actor);
        vm.prank(actor);
        pool.requestBorrow(r); // synchronous; credits sealed USDC

        // EQX-01 ghost: borrow is gated on REMAINING room (eMax - currentDebt), all-or-nothing.
        uint256 eMax = (ghostCollateral * uint256(PRICE) * 7000) / 10000;
        uint256 room = eMax > ghostScaledDebt ? eMax - ghostScaledDebt : 0;
        uint256 approved = amt <= room ? amt : 0;
        ghostScaledDebt += approved; // index == 1.0
        ghostUsdcCredit += approved;
    }

    function repay(uint64 amt) public {
        if (ghostUsdcCredit == 0) return;
        amt = uint64(bound(amt, 1, 3000));
        InEuint64 memory e = createInEuint64(amt, actor);
        vm.prank(actor);
        pool.repay(e); // draws from sealed credit

        uint256 pay = amt > ghostUsdcCredit ? ghostUsdcCredit : amt;
        uint256 scaledPaid = pay > ghostScaledDebt ? ghostScaledDebt : pay; // index == 1.0
        ghostScaledDebt -= scaledPaid;
        ghostUsdcCredit -= scaledPaid; // USDC consumed == scaledPaid at index 1.0
    }
}

contract PoolInvariantTest is CoFheTest {
    MockUSDC usdc;
    MockDShares dsh;
    KYCRegistry kyc;
    EquinoxPool pool;
    PoolHandler handler;

    address actor = makeAddr("actor");
    uint256 constant ATTESTER_PK = 0xA77E5715;
    uint64 constant PRICE = 342;
    uint256 constant WEEKDAY = 1_704_283_200;

    function setUp() public {
        vm.warp(WEEKDAY);
        address attester = vm.addr(ATTESTER_PK);
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
        usdc.mint(address(pool), 100_000_000 * 1e6);
        pool.setBorrowRate(0); // frozen index for exact ghost math

        handler = new PoolHandler(pool, dsh, usdc, actor);

        uint256 expiry = block.timestamp + 365 days;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_PK, kyc.attestationDigest(actor, expiry));
        bytes memory sig = abi.encodePacked(r, s, v);
        InEuint64 memory s0 = createInEuint64(uint64(12345), actor);
        vm.prank(actor);
        kyc.register(expiry, sig);
        vm.prank(actor);
        pool.initBlinding(s0);

        pool.grantRole(ORACLE_MANAGER_ROLE, address(handler)); // let the handler refresh price

        bytes4[] memory sel = new bytes4[](3);
        sel[0] = PoolHandler.deposit.selector;
        sel[1] = PoolHandler.borrow.selector;
        sel[2] = PoolHandler.repay.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    /// @notice The sealed collateral always equals the plaintext ghost ledger.
    function invariant_collateralMatchesGhost() public view {
        assertHashValue(pool.encryptedCollateralOf(actor), uint64(handler.ghostCollateral()));
    }

    /// @notice The sealed scaled debt always equals the plaintext ghost ledger.
    function invariant_scaledDebtMatchesGhost() public view {
        assertHashValue(pool.encryptedScaledDebtOf(actor), uint64(handler.ghostScaledDebt()));
    }

    /// @notice AUDIT EQX-01: total debt can never exceed the collateral's LTV capacity.
    ///         Combined with scaledDebtMatchesGhost (real == ghost) this proves the real
    ///         sealed debt also respects the cap — i.e. the pool can no longer be drained.
    function invariant_debtNeverExceedsLtvCapacity() public view {
        uint256 capacity = (handler.ghostCollateral() * uint256(PRICE) * 7000) / 10000;
        assertLe(handler.ghostScaledDebt(), capacity, "debt exceeded LTV capacity");
    }
}
