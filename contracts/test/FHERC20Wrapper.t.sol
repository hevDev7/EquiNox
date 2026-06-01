// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {CofheTest} from "@cofhe/foundry-plugin/contracts/CofheTest.sol";
import {CofheClient} from "@cofhe/foundry-plugin/contracts/CofheClient.sol";
import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MockDShares} from "../src/mocks/MockERC20.sol";
import {FHERC20Wrapper} from "../src/FHERC20Wrapper.sol";

/// @notice FHERC20Wrapper on the official CoFHE Foundry harness. Exercises the CoFHE 0.1.x
///         proof model (requestUnwrap → allowPublic → decryptForTx_withoutPermit →
///         verifyDecryptResult) and the FHERC20/ERC-7984 conformance surface (AUDIT #4/#5).
contract FHERC20WrapperTest is CofheTest {
    MockDShares dsh;
    FHERC20Wrapper wrapper;
    CofheClient client;
    uint256 constant USER_PK = 0xB0B5;
    address user;

    function setUp() public {
        deployMocks();
        client = createCofheClient();
        client.connect(USER_PK);
        user = vm.addr(USER_PK);

        dsh = new MockDShares();
        wrapper = FHERC20Wrapper(
            address(
                new ERC1967Proxy(
                    address(new FHERC20Wrapper()),
                    abi.encodeCall(FHERC20Wrapper.initialize, (address(this), IERC20(address(dsh)), "Fhenix bTSLA", "fbTSLA", 6))
                )
            )
        );
        dsh.mint(user, 100 * 1e6);
        vm.prank(user);
        dsh.approve(address(wrapper), type(uint256).max);
    }

    function _wrap(uint64 amount) internal {
        vm.prank(user);
        wrapper.wrap(amount);
    }

    /// @dev Threshold-decrypt the claim's sealed `take` handle into (value, proof) — the mock
    ///      equivalent of the SDK's decryptForTx().withoutPermit() for a publicly-allowed handle.
    function _proof(uint256 cid) internal view returns (uint64 value, bytes memory proof) {
        (, euint64 takeH,,) = wrapper.claims(cid);
        (, uint256 v, bytes memory p) = client.decryptForTx_withoutPermit(euint64.unwrap(takeH));
        return (uint64(v), p);
    }

    // ---- FHERC20/ERC-7984 conformance (AUDIT #4/#5) ----------------------------

    function test_Conformance_markersAndNonTransferable() public {
        assertTrue(wrapper.isFherc20(), "isFherc20 marker");
        assertLt(wrapper.indicatorOf(user), 10_000, "indicatorOf is a 0..9999 decoy, not the holding");
        vm.expectRevert(FHERC20Wrapper.NonTransferable.selector);
        wrapper.transfer(address(0xBEEF), 1);
        vm.expectRevert(FHERC20Wrapper.NonTransferable.selector);
        wrapper.approve(address(0xBEEF), 1);
    }

    function test_Wrap_holdsUnderlying_andSealsBalance() public {
        _wrap(100 * 1e6);
        assertEq(dsh.balanceOf(address(wrapper)), 100 * 1e6, "underlying held by wrapper");
        expectPlaintext(wrapper.confidentialBalanceOf(user), uint64(100 * 1e6));
    }

    // ---- delayed unwrap via the proof model ------------------------------------

    function test_Unwrap_proofModel_returnsPlaintext() public {
        _wrap(100 * 1e6);
        // create the input BOUND to the connected account BEFORE pranking; submit AS that account
        InEuint64 memory enc = client.createInEuint64(uint64(40 * 1e6));
        vm.prank(user);
        uint256 cid = wrapper.requestUnwrap(enc);

        (uint64 val, bytes memory proof) = _proof(cid);
        // NOTE: a tampered (amount, proof) makes FHE.verifyDecryptResult return false on a real
        // chain → our contract reverts DecryptionPending; the mock instead reverts InvalidSigner
        // inside verifyDecryptResult, so that branch is not unit-testable here. Happy path below.
        uint256 before = dsh.balanceOf(user);
        vm.prank(user);
        wrapper.claimUnwrapped(cid, val, proof);
        assertEq(dsh.balanceOf(user) - before, 40 * 1e6, "claimed plaintext shares");
    }

    function test_Claim_RevertsForNonOwner() public {
        _wrap(100 * 1e6);
        InEuint64 memory enc = client.createInEuint64(uint64(40 * 1e6));
        vm.prank(user);
        uint256 cid = wrapper.requestUnwrap(enc);
        (uint64 val, bytes memory proof) = _proof(cid);
        vm.prank(makeAddr("other"));
        vm.expectRevert(FHERC20Wrapper.NotClaimOwner.selector);
        wrapper.claimUnwrapped(cid, val, proof);
    }

    function test_Claim_RevertsOnDoubleClaim() public {
        _wrap(100 * 1e6);
        InEuint64 memory enc = client.createInEuint64(uint64(40 * 1e6));
        vm.prank(user);
        uint256 cid = wrapper.requestUnwrap(enc);
        (uint64 val, bytes memory proof) = _proof(cid);
        vm.prank(user);
        wrapper.claimUnwrapped(cid, val, proof);
        vm.prank(user);
        vm.expectRevert(FHERC20Wrapper.AlreadyClaimed.selector);
        wrapper.claimUnwrapped(cid, val, proof);
    }

    function test_Wrap_RevertsOnZero() public {
        vm.prank(user);
        vm.expectRevert(FHERC20Wrapper.ZeroAmount.selector);
        wrapper.wrap(0);
    }

    function test_Wrap_RevertsOnTooLarge() public {
        vm.prank(user);
        vm.expectRevert(FHERC20Wrapper.AmountTooLarge.selector);
        wrapper.wrap(uint256(type(uint64).max) + 1);
    }

    function test_Pause_BlocksWrap() public {
        wrapper.pause(); // this == admin holds PAUSER_ROLE
        vm.prank(user);
        vm.expectRevert(); // EnforcedPause
        wrapper.wrap(1);
    }
}
