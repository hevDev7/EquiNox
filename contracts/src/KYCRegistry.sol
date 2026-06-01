// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {UPGRADER_ROLE} from "./access/EquinoxRoles.sol";

/// @title KYCRegistry — attester-gated KYC (PRD §3.1), UUPS upgradeable.
/// @notice Registration requires a fresh attestation **signed by a trusted KYC
///         attester** (off-chain provider) over (user, expiry, registry, chainId),
///         verified on-chain via ECDSA — so KYC cannot be self-asserted. The
///         attester's ECDSA signature is the *sole* authoritative access gate; the
///         public chain only learns that an address registered, never the identity.
///
/// @dev    AUDIT EQX-08: a previous revision also stored a client-supplied encrypted
///         `ebool` "validity bit" and exposed it via `verifiedStatus`. That bit was
///         never consumed by any access-control path (the attester signature is the
///         gate), was entirely user-chosen, and so was decorative dead code whose
///         only effect was misleading "selective-disclosure" NatSpec. It has been
///         removed. If selective disclosure of attributes is ever required, it must
///         be bound into the *attester's* signed payload, not supplied by the user.
/// @dev    AUDIT EQX-09: registration is now single-use per address
///         (`AlreadyRegistered`). Because the digest is bound to `msg.sender`, a
///         signature can never be replayed to register a *different* address; the
///         single-use guard additionally prevents re-registering (and thus replaying
///         the same signature against) an already-registered address until expiry.
contract KYCRegistry is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    /// @dev public, low-information gate flag used by the pool.
    mapping(address => bool) public registered;
    /// @dev trusted off-chain KYC attester (EOA/HSM) whose signature authorizes registration.
    address public attester;

    uint256[48] private __gap;

    error ZeroAttester();
    error AttestationExpired();
    error InvalidAttestation();
    error AlreadyRegistered();

    event Registered(address indexed user);
    event AttesterUpdated(address attester);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param admin    TimelockController (multisig-controlled) in production.
    /// @param attester_ trusted KYC attester signing key.
    function initialize(address admin, address attester_) external initializer {
        if (attester_ == address(0)) revert ZeroAttester();
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        attester = attester_;
        emit AttesterUpdated(attester_);
    }

    function setAttester(address attester_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (attester_ == address(0)) revert ZeroAttester();
        attester = attester_;
        emit AttesterUpdated(attester_);
    }

    /// @notice EIP-191 digest the attester signs to authorize `user` until `expiry`.
    function attestationDigest(address user, uint256 expiry) public view returns (bytes32) {
        bytes32 raw = keccak256(abi.encodePacked(user, expiry, address(this), block.chainid));
        return MessageHashUtils.toEthSignedMessageHash(raw);
    }

    /// @notice Register with an attester-signed attestation.
    /// @param expiry    attestation expiry (unix seconds).
    /// @param signature attester's ECDSA signature over `attestationDigest(msg.sender, expiry)`.
    function register(uint256 expiry, bytes calldata signature) external {
        if (registered[msg.sender]) revert AlreadyRegistered();
        if (block.timestamp > expiry) revert AttestationExpired();
        if (ECDSA.recover(attestationDigest(msg.sender, expiry), signature) != attester) {
            revert InvalidAttestation();
        }
        registered[msg.sender] = true;
        emit Registered(msg.sender);
    }

    function isRegistered(address user) external view returns (bool) {
        return registered[user];
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}
