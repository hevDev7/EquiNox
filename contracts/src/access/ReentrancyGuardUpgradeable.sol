// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title ReentrancyGuardUpgradeable
/// @notice Minimal reentrancy guard with ERC-7201 namespaced storage (upgrade-safe).
///         Vendored because this OZ contracts-upgradeable build omits the util.
abstract contract ReentrancyGuardUpgradeable is Initializable {
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    /// @custom:storage-location erc7201:equinox.storage.ReentrancyGuard
    struct ReentrancyGuardStorage {
        uint256 status;
    }

    // cast index-erc7201 "equinox.storage.ReentrancyGuard"
    bytes32 private constant STORAGE_SLOT = 0x73809ba9944b4018a2a9c4b2963c8d3907513ef5fe5064bb5a7ca9c8d7b25d00;

    error ReentrancyGuardReentrantCall();

    function _s() private pure returns (ReentrancyGuardStorage storage $) {
        assembly {
            $.slot := STORAGE_SLOT
        }
    }

    function __ReentrancyGuard_init() internal onlyInitializing {
        _s().status = NOT_ENTERED;
    }

    modifier nonReentrant() {
        ReentrancyGuardStorage storage $ = _s();
        if ($.status == ENTERED) revert ReentrancyGuardReentrantCall();
        $.status = ENTERED;
        _;
        $.status = NOT_ENTERED;
    }
}
