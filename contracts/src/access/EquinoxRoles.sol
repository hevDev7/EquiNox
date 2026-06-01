// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @dev Shared role identifiers. Admin (DEFAULT_ADMIN_ROLE) is intended to be a
///      TimelockController controlled by a multisig in production.
bytes32 constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");
bytes32 constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
bytes32 constant ORACLE_MANAGER_ROLE = keccak256("ORACLE_MANAGER_ROLE");
bytes32 constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
