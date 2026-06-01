// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "./access/ReentrancyGuardUpgradeable.sol";
import {PAUSER_ROLE, UPGRADER_ROLE} from "./access/EquinoxRoles.sol";

/// @notice Minimal confidential-token surface this wrapper advertises for ERC-165 discovery,
///         aligned with Fhenix's FHERC20 / ERC-7984 standard (the canonical interface lives in
///         the separate fhenix-confidential-contracts repo; this is the conformance marker).
interface IConfidentialERC20Marker {
    function isFherc20() external pure returns (bool);
    function confidentialBalanceOf(address account) external view returns (euint64);
}

/// @title FHERC20Wrapper — encrypted wrapper for tokenized equities (PRD §3.2 / §3.5).
/// @notice Wraps a plaintext ERC-20 (e.g. dTSLA) into a confidential FHERC20 (fbTSLA).
///         Real balances live in `euint64` (`confidentialBalanceOf`); unwrapping uses a
///         delayed claim because threshold decryption resolves a few blocks later.
/// @dev    AUDIT (Fhenix tech review) #4/#5 — minimum FHERC20/ERC-7984 conformance:
///         advertises `isFherc20()` + ERC-165 `supportsInterface`, exposes the standard
///         `confidentialBalanceOf` name, and makes the value-bearing ERC-20 surface
///         (transfer/transferFrom/approve) REVERT (NonTransferable) so a wallet/indexer fails
///         loudly instead of reading the non-ERC20 `indicatorOf` decoy. This is NOT a
///         transferable token; it has no allowance/operator model. UUPS upgradeable.
contract FHERC20Wrapper is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    IERC20 public underlying;
    string public name;
    string public symbol;
    uint8 public decimals;

    mapping(address => euint64) private _encBalance;
    mapping(address => bool) private _inited;

    struct UnwrapClaim {
        address owner;
        euint64 amount; // sealed; decrypted by the coprocessor a few blocks later
        uint64 requestedAt;
        bool claimed;
    }

    UnwrapClaim[] public claims;

    uint256[45] private __gap;

    error ZeroAmount();
    error AmountTooLarge();
    error NotClaimOwner();
    error AlreadyClaimed();
    error DecryptionPending();
    error NonTransferable(); // AUDIT #4: this confidential wrapper is non-transferable

    event Wrapped(address indexed user);
    event UnwrapRequested(address indexed owner, uint256 indexed claimId);
    event UnwrapClaimed(address indexed owner, uint256 indexed claimId, uint64 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        IERC20 underlying_,
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_
    ) external initializer {
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        underlying = underlying_;
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    // --------------------------------------------------------------------- wrap

    function wrap(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint64).max) revert AmountTooLarge();
        underlying.safeTransferFrom(msg.sender, address(this), amount);
        _credit(msg.sender, uint64(amount));
        emit Wrapped(msg.sender);
    }

    function _credit(address user, uint64 amount) internal {
        euint64 add = FHE.asEuint64(uint256(amount));
        euint64 bal = _inited[user] ? FHE.add(_encBalance[user], add) : add;
        _inited[user] = true;
        _encBalance[user] = bal;
        FHE.allowThis(bal);
        FHE.allowSender(bal);
    }

    /// @notice A 0–9999 activity indicator — NEVER the real holding. Renamed from `balanceOf`
    ///         (AUDIT #5) so no wallet/indexer mistakes it for an ERC-20 balance: it is a
    ///         deliberate decoy, decoupled from the real holding (which lives only in the
    ///         `euint64` `confidentialBalanceOf` handle) and provides no confidentiality on its
    ///         own. There is intentionally NO `balanceOf` — a wallet reading it reverts (loud).
    function indicatorOf(address account) external view returns (uint256) {
        return uint256(keccak256(abi.encodePacked(block.prevrandao, account, block.number))) % 10000;
    }

    /// @notice Standard FHERC20 confidential balance — the sealed `euint64` holding. Owner
    ///         decrypts via the SDK self-permit; the contract grants ACL in `_credit`.
    function confidentialBalanceOf(address account) external view returns (euint64) {
        return _encBalance[account];
    }

    /// @dev Deprecated alias for back-compat with pre-conformance callers.
    function encryptedBalanceOf(address account) external view returns (euint64) {
        return _encBalance[account];
    }

    // --------------------------------------------------- FHERC20 standard conformance (AUDIT #4)

    /// @notice Fhenix discovery marker — lets a confidential-aware wallet/indexer detect that
    ///         this token's value is sealed (so it must read `confidentialBalanceOf`, not ERC-20).
    function isFherc20() external pure returns (bool) {
        return true;
    }

    /// @dev ERC-165: advertise the confidential-token marker interface alongside AccessControl's.
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return interfaceId == type(IConfidentialERC20Marker).interfaceId || super.supportsInterface(interfaceId);
    }

    // ---- value-bearing ERC-20 surface: REVERTS (this wrapper is non-transferable) ----
    function transfer(address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }

    function approve(address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }

    // ------------------------------------------------------------ delayed unwrap

    function requestUnwrap(InEuint64 calldata encAmount) external whenNotPaused nonReentrant returns (uint256 claimId) {
        euint64 amt = FHE.asEuint64(encAmount);
        ebool ok = FHE.lte(amt, _encBalance[msg.sender]);
        euint64 take = FHE.select(ok, amt, FHE.asEuint64(0));

        euint64 newBal = FHE.sub(_encBalance[msg.sender], take);
        _encBalance[msg.sender] = newBal;
        FHE.allowThis(newBal);
        FHE.allowSender(newBal);

        FHE.allowThis(take);
        // CoFHE 0.1.x: make publicly decryptable (off-chain threshold decrypt) — replaces FHE.decrypt.
        FHE.allowPublic(take);

        claims.push(UnwrapClaim({owner: msg.sender, amount: take, requestedAt: uint64(block.timestamp), claimed: false}));
        claimId = claims.length - 1;
        emit UnwrapRequested(msg.sender, claimId);
    }

    function claimUnwrapped(uint256 claimId, uint64 amount, bytes calldata proof) external nonReentrant {
        UnwrapClaim storage c = claims[claimId];
        if (c.owner != msg.sender) revert NotClaimOwner();
        if (c.claimed) revert AlreadyClaimed();
        // CoFHE 0.1.x proof model: verify the off-chain threshold decryption of the sealed amount.
        if (!FHE.verifyDecryptResult(c.amount, amount, proof)) revert DecryptionPending();
        c.claimed = true;
        if (amount > 0) underlying.safeTransfer(msg.sender, amount);
        emit UnwrapClaimed(msg.sender, claimId, amount);
    }

    function claimsCount() external view returns (uint256) {
        return claims.length;
    }

    // --------------------------------------------------------------------- admin

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}
