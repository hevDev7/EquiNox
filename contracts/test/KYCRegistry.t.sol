// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {KYCRegistry} from "../src/KYCRegistry.sol";

/// @notice KYC requires a fresh attestation signed by the trusted attester.
///         (Migrated to plain forge-std Test — KYCRegistry is ECDSA-based, uses no FHE.)
contract KYCRegistryTest is Test {
    KYCRegistry kyc;
    uint256 constant PK = 0xA77E5715;
    address attester;
    address user = makeAddr("user");

    function setUp() public {
        vm.warp(1_704_283_200);
        attester = vm.addr(PK);
        kyc = KYCRegistry(
            address(
                new ERC1967Proxy(
                    address(new KYCRegistry()), abi.encodeCall(KYCRegistry.initialize, (address(this), attester))
                )
            )
        );
    }

    function _sig(uint256 pk, address who, uint256 expiry) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, kyc.attestationDigest(who, expiry));
        return abi.encodePacked(r, s, v);
    }

    function test_Register_WithValidAttestation() public {
        uint256 exp = block.timestamp + 1 days;
        bytes memory sig = _sig(PK, user, exp);
        vm.prank(user);
        kyc.register(exp, sig);
        assertTrue(kyc.isRegistered(user), "registered");
    }

    function test_Register_RevertsOnWrongSigner() public {
        uint256 exp = block.timestamp + 1 days;
        bytes memory bad = _sig(0xDEAD, user, exp); // not the attester
        vm.prank(user);
        vm.expectRevert(KYCRegistry.InvalidAttestation.selector);
        kyc.register(exp, bad);
    }

    function test_Register_RevertsOnExpired() public {
        uint256 exp = block.timestamp - 1;
        bytes memory sig = _sig(PK, user, exp);
        vm.prank(user);
        vm.expectRevert(KYCRegistry.AttestationExpired.selector);
        kyc.register(exp, sig);
    }

    function test_Register_RevertsIfAttestationIsForAnotherUser() public {
        uint256 exp = block.timestamp + 1 days;
        bytes memory sigForUser = _sig(PK, user, exp); // bound to `user`, not the caller
        address other = makeAddr("other");
        vm.prank(other);
        vm.expectRevert(KYCRegistry.InvalidAttestation.selector);
        kyc.register(exp, sigForUser);
    }

    /// @notice AUDIT EQX-09 — registration is single-use; the same signature cannot be
    ///         replayed against an already-registered address.
    function test_Register_RevertsOnAlreadyRegistered() public {
        uint256 exp = block.timestamp + 1 days;
        bytes memory sig = _sig(PK, user, exp);
        vm.prank(user);
        kyc.register(exp, sig);
        vm.prank(user);
        vm.expectRevert(KYCRegistry.AlreadyRegistered.selector);
        kyc.register(exp, sig); // replay of the still-valid signature is now blocked
    }

    function test_SetAttester_OnlyAdmin() public {
        vm.prank(user);
        vm.expectRevert();
        kyc.setAttester(user);

        address next = makeAddr("next");
        kyc.setAttester(next); // this == DEFAULT_ADMIN_ROLE
        assertEq(kyc.attester(), next, "attester rotated");
    }

    function test_SetAttester_RevertsOnZero() public {
        vm.expectRevert(KYCRegistry.ZeroAttester.selector);
        kyc.setAttester(address(0));
    }

    function test_Initialize_RevertsOnZeroAttester() public {
        KYCRegistry impl = new KYCRegistry();
        vm.expectRevert(KYCRegistry.ZeroAttester.selector);
        new ERC1967Proxy(address(impl), abi.encodeCall(KYCRegistry.initialize, (address(this), address(0))));
    }
}
