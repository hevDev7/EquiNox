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
import {KYCRegistry} from "./KYCRegistry.sol";
import {IOracle} from "./oracle/IOracle.sol";
import {ORACLE_MANAGER_ROLE, GOVERNOR_ROLE, PAUSER_ROLE, UPGRADER_ROLE} from "./access/EquinoxRoles.sol";

/// @dev Chainlink L2 sequencer-uptime feed (answer: 0 = up, 1 = down).
interface ISequencerFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @title EquinoxPool — Confidential Equities Lending Primitive (PRD §3.3, §3.4, §4).
/// @notice Sealed collateral C + scaled debt + secret blinding s. Public blinded
///         factors A = s·C·LT and B = s·scaledDebt are exposed; the secret `s` cancels
///         in the health factor, hiding C and D. Debt accrues via a public per-second
///         borrow index (scaled-debt model). UUPS, role-gated.
///
/// @dev CONFIDENTIAL SETTLEMENT (AUDIT EQX-02). Plaintext token transfers leak the
///      amounts FHE is meant to hide, so all *position* operations
///      (deposit/borrow/repay/liquidate) act on sealed `euint64` internal balances and
///      NEVER publicly `FHE.decrypt` a position value. Real ERC-20s only move at two
///      explicitly plaintext, position-decoupled *edges*:
///        - funding:  `fundShares` / `fundUsdc` top up an idle, sealed credit balance;
///        - withdrawing: `requestWithdraw` → `claimWithdraw` burns sealed credit and,
///          after threshold decryption, pays out the (now public) withdrawn amount.
///      Because borrow proceeds are credited to a sealed `_eUsdcCredit` rather than
///      disbursed, and because deposits/repayments are drawn from sealed credit, the
///      position values C and D never appear in calldata, events, or a global decrypt.
///      With C and D sealed, the public pair (A = s·C·LT, B = s·scaledDebt) is two
///      equations in three unknowns (s, C, D) — under-determined — so neither the
///      blinding `s` nor the absolute C/D can be recovered (closing the EQX-02 break,
///      which relied on a publicly-disbursed D to solve s = B/D).
///
///      RESIDUAL (documented, inherent): the *aggregate* dShares/USDC the pool holds,
///      and the public amounts at the fund/withdraw edges, are observable. Privacy of a
///      position therefore depends on users decoupling funding/withdrawal amounts and
///      timing from their borrow/deposit sizes (e.g. funding round amounts, withdrawing
///      in unrelated tranches). Per-tx amount-unlinkability at the token edge would
///      require a shielded pool / batching and is out of scope for this primitive.
contract EquinoxPool is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    uint64 public constant BPS = 10_000;
    uint64 public constant LT_BPS = 8_000; // liquidation threshold 80%
    uint64 public constant LTV_BPS = 7_000; // max loan-to-value 70%
    uint64 public constant HAIRCUT_BPS = 1_500; // weekend collateral haircut 15%
    uint64 public constant LIQ_BONUS_BPS = 750; // liquidation bonus 7.5%
    uint64 public constant CLOSE_FACTOR_BPS = 5_000; // max 50% of debt per liquidation
    uint256 public constant DSHARE_UNIT = 1e6;
    uint256 public constant USDC_UNIT = 1e6;
    uint256 public constant STALENESS = 60;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint64 public constant DEFAULT_RATE_BPS = 480; // 4.8% annual (legacy seed; rate now utilization-based)

    // ---- Interest-rate model (Batch C): utilization-based kinked curve (Aave-style).
    uint64 public constant KINK_BPS = 8_000; // optimal utilization = 80%
    uint64 public constant BASE_RATE_BPS = 0; // borrow APR at 0% utilization
    uint64 public constant SLOPE1_BPS = 600; // +6% APR reaching the kink (→6% APR at 80% util)
    uint64 public constant SLOPE2_BPS = 6_000; // steep slope above the kink (→66% APR at 100% util)
    uint64 public constant RESERVE_FACTOR_BPS = 1_500; // 15% of borrow interest → protocol reserve

    // AUDIT EQX-07 — manual `setPrice` bounds (absolute band + per-update deviation cap).
    uint64 public constant MIN_PRICE = 1;
    uint64 public constant MAX_PRICE = 1_000_000; // $1,000,000 / share absolute ceiling
    uint64 public constant MAX_PRICE_DEVIATION_BPS = 2_000; // 20% per manual update

    IERC20 public dShares;
    IERC20 public usdc;
    KYCRegistry public kyc;

    uint64 public price; // whole USD per share
    uint256 public priceUpdatedAt;

    // interest: public borrow index in bps (the PRD's `I`), starts at BPS (=1.0)
    uint64 public borrowRateBps;
    uint256 public storedIndexBps;
    uint256 public indexUpdatedAt;

    IOracle public oracle;

    // per-user sealed state
    mapping(address => euint64) private _eCollateral; // shares deployed as collateral
    mapping(address => euint64) private _eScaledDebt; // scaled principal (nominal·BPS/index@borrow)
    mapping(address => euint64) private _eBlinding; // secret s
    mapping(address => euint64) private _eShareCredit; // idle wrapped shares (funded, not yet collateral)
    mapping(address => euint64) private _eUsdcCredit; // idle USDC credit (borrow proceeds / repay & liq funds)
    mapping(address => bool) public initialized;

    // per-user public blinded factors (sound while C and D stay sealed — see EQX-02 note)
    mapping(address => uint256) public factorA; // s·C·LT_bps
    mapping(address => uint256) public factorB; // s·scaledDebt
    mapping(address => bool) public factorsReady; // latest recompute has been poked
    mapping(address => bool) public factorsSettledOnce; // EQX-04: factors poked at least once
    mapping(address => uint256) public factorsAt; // EQX-04: timestamp of last successful poke
    mapping(address => euint128) private _eA;
    mapping(address => euint128) private _eB;
    mapping(address => bool) public liquidated;

    // AUDIT EQX-02 — plaintext token edge: sealed credit burned now, paid out after decrypt.
    struct Withdrawal {
        address owner;
        euint64 amount; // sealed; decrypted by the coprocessor a few blocks later
        bool isUsdc; // true => USDC payout, false => dShares payout
        bool claimed;
    }

    Withdrawal[] public withdrawals;

    /// @dev TESTNET ONLY: when true, isWeekendMode() returns false so borrow can be
    ///      exercised off market-hours. Appended before __gap → upgrade-safe layout.
    bool public weekendOverride;

    // ---- USDC liquidity supply side (PUBLIC): LPs fund the borrowable USDC pool.
    //      Appended before __gap → upgrade-safe layout.
    //      Batch C: lpShares / totalLpSupplied now hold SCALED shares
    //      (whole-USDC · BPS / supplyIndexBps). Claimable USDC grows with supplyIndexBps.
    //      Safe re-interpretation: no LP positions existed at the Batch-C upgrade.
    mapping(address => uint256) public lpShares; // scaled LP shares (NOT whole USDC)
    uint256 public totalLpSupplied; // total scaled LP shares

    // Chainlink L2 sequencer-uptime feed (Arbitrum). 0 = unset → check skipped (testnet).
    address public sequencerUptimeFeed;
    uint256 public sequencerGracePeriod;

    // ---- LP supply-side economics (Batch C). supplyIndexBps mirrors the borrow index
    //      for the LP side; lazy-init: a stored 0 is treated as BPS (=1.0).
    uint256 public supplyIndexBps; // LP yield index (0 => 1.0 until first accrual)
    uint256 public reserveAccruedUsdc; // protocol reserve, micro-USDC

    uint256[17] private __gap;

    error AlreadyInitialized();
    error NotInitialized();
    error BadAmount();
    error WeekendBreaker();
    error StaleOracle();
    error NotOwner();
    error AlreadyClaimed();
    error DecryptionPending();
    error FactorsNotSettled();
    error Healthy();
    error KycRequired();
    error NoOracle();
    error PriceOutOfBounds();
    error PriceDeviationTooHigh();
    error InsufficientLiquidity();
    error SequencerDown();

    event BlindingSet(address indexed user);
    event SharesFunded(address indexed user, uint256 shares);
    event UsdcFunded(address indexed user, uint256 amount);
    event Deposited(address indexed user); // amount sealed
    event BorrowRequested(address indexed user); // amount sealed
    event Repaid(address indexed user); // amount sealed
    event WithdrawRequested(address indexed user, uint256 indexed withdrawId, bool isUsdc);
    event WithdrawClaimed(address indexed user, uint256 indexed withdrawId, bool isUsdc, uint64 amount);
    event FactorsUpdated(address indexed user, uint256 a, uint256 b);
    event Liquidated(address indexed user, address indexed liquidator); // amount sealed
    event PriceUpdated(uint64 price, uint256 at);
    event RateUpdated(uint64 rateBps);
    event LiquidityProvided(address indexed lp, uint256 amount);
    event LiquidityWithdrawn(address indexed lp, uint256 amount);
    event ReserveWithdrawn(address indexed to, uint256 microAmount);
    event OracleUpdated(address oracle);

    modifier onlyKyc() {
        if (!kyc.isRegistered(msg.sender)) revert KycRequired();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, IERC20 dShares_, IERC20 usdc_, KYCRegistry kyc_, uint64 initialPrice_)
        external
        initializer
    {
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);
        _grantRole(ORACLE_MANAGER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        dShares = dShares_;
        usdc = usdc_;
        kyc = kyc_;
        if (initialPrice_ < MIN_PRICE || initialPrice_ > MAX_PRICE) revert PriceOutOfBounds();
        price = initialPrice_;
        priceUpdatedAt = block.timestamp;
        borrowRateBps = DEFAULT_RATE_BPS;
        storedIndexBps = BPS;
        indexUpdatedAt = block.timestamp;
    }

    // ------------------------------------------------------------------- oracle

    /// @notice Manual price override. AUDIT EQX-07: bounded to an absolute band and a
    ///         per-update deviation cap so a single role-holder cannot set 0 (DoS) or a
    ///         huge value (over-borrow). The deviation cap only blocks single-tx
    ///         fat-fingers; the authoritative defence is role custody (timelock+multisig,
    ///         see DeployProduction). Large legitimate moves should arrive via `syncPrice`
    ///         from the guarded Pyth adapter, which is the trusted price source.
    function setPrice(uint64 newPrice) external onlyRole(ORACLE_MANAGER_ROLE) {
        if (newPrice < MIN_PRICE || newPrice > MAX_PRICE) revert PriceOutOfBounds();
        uint64 cur = price;
        if (cur != 0) {
            uint256 hi = (uint256(cur) * (uint256(BPS) + uint256(MAX_PRICE_DEVIATION_BPS))) / uint256(BPS);
            uint256 lo = (uint256(cur) * (uint256(BPS) - uint256(MAX_PRICE_DEVIATION_BPS))) / uint256(BPS);
            if (uint256(newPrice) > hi || uint256(newPrice) < lo) revert PriceDeviationTooHigh();
        }
        price = newPrice;
        priceUpdatedAt = block.timestamp;
        emit PriceUpdated(newPrice, block.timestamp);
    }

    function setBorrowRate(uint64 newRateBps) external onlyRole(GOVERNOR_ROLE) {
        _accrue();
        borrowRateBps = newRateBps;
        emit RateUpdated(newRateBps);
    }

    function setOracle(IOracle newOracle) external onlyRole(GOVERNOR_ROLE) {
        oracle = newOracle;
        emit OracleUpdated(address(newOracle));
    }

    /// @notice Pull the price from the trusted Pyth adapter (which enforces its own
    ///         staleness/confidence guards). No deviation cap here: the adapter is the
    ///         authoritative source and must be able to track real market moves.
    function syncPrice() external {
        if (address(oracle) == address(0)) revert NoOracle();
        uint64 p = oracle.priceUSD();
        if (p < MIN_PRICE || p > MAX_PRICE) revert PriceOutOfBounds();
        price = p;
        priceUpdatedAt = block.timestamp;
        emit PriceUpdated(p, block.timestamp);
    }

    // ----------------------------------------------------------------- interest

    /// @notice Live borrow index in bps (PRD `I`); starts at BPS (1.0) and accrues at the
    ///         utilization-based borrow rate (Batch C).
    function currentIndexBps() public view returns (uint256) {
        uint256 dt = block.timestamp - indexUpdatedAt;
        if (dt == 0) return storedIndexBps;
        return storedIndexBps + (storedIndexBps * currentBorrowRateBps() * dt) / (uint256(BPS) * SECONDS_PER_YEAR);
    }

    function _accrue() internal {
        uint256 dt = block.timestamp - indexUpdatedAt;
        if (dt == 0) return;
        uint256 rate = currentBorrowRateBps();
        storedIndexBps = storedIndexBps + (storedIndexBps * rate * dt) / (uint256(BPS) * SECONDS_PER_YEAR);
        _accrueSupply(dt, rate);
        indexUpdatedAt = block.timestamp;
    }

    /// @dev Grow the LP supply index + protocol reserve over `dt` seconds at the given borrow rate.
    ///      supplyRate = borrowRate · utilization · (1 − reserveFactor); reserve = the skimmed slice.
    function _accrueSupply(uint256 dt, uint256 borrowRate) internal {
        uint256 si = supplyIndexBps == 0 ? uint256(BPS) : supplyIndexBps;
        uint256 suppliedScaled = totalLpSupplied;
        if (suppliedScaled > 0 && borrowRate > 0) {
            uint256 util = _utilizationBps();
            if (util > 0) {
                uint256 suppliedUsdc = (suppliedScaled * si) / uint256(BPS); // whole USDC owed to LPs
                uint256 borrowedMicro = ((suppliedUsdc * util) / uint256(BPS)) * USDC_UNIT;
                // reserve += borrowed · borrowRate · reserveFactor · dt   (absolute, micro-USDC)
                reserveAccruedUsdc += (borrowedMicro * borrowRate * uint256(RESERVE_FACTOR_BPS) * dt)
                    / (uint256(BPS) * uint256(BPS) * SECONDS_PER_YEAR);
                // supplyRate (bps) = borrowRate · util/BPS · (BPS − reserveFactor)/BPS
                uint256 supplyRate =
                    (((borrowRate * util) / uint256(BPS)) * (uint256(BPS) - uint256(RESERVE_FACTOR_BPS))) / uint256(BPS);
                si = si + (si * supplyRate * dt) / (uint256(BPS) * SECONDS_PER_YEAR);
            }
        }
        supplyIndexBps = si;
    }

    // ----------------------------------------------------- rate model + LP views (Batch C)

    /// @notice Pool utilization in bps (0..BPS): borrowed-out USDC / USDC owed to LPs.
    /// @dev Public-only proxy based on the pool's USDC balance vs. LP claims — leaks no
    ///      individual (sealed) debt; only the aggregate outflow, already visible on-chain.
    function _utilizationBps() internal view returns (uint256) {
        uint256 si = supplyIndexBps == 0 ? uint256(BPS) : supplyIndexBps;
        uint256 suppliedUsdc = (totalLpSupplied * si) / uint256(BPS);
        if (suppliedUsdc == 0) return 0;
        uint256 freeUsdc = usdc.balanceOf(address(this)) / USDC_UNIT;
        uint256 borrowed = suppliedUsdc > freeUsdc ? suppliedUsdc - freeUsdc : 0;
        uint256 u = (borrowed * uint256(BPS)) / suppliedUsdc;
        return u > uint256(BPS) ? uint256(BPS) : u;
    }

    function utilizationBps() external view returns (uint256) {
        return _utilizationBps();
    }

    /// @notice Current annual borrow rate in bps from the kinked utilization curve.
    function currentBorrowRateBps() public view returns (uint256) {
        uint256 u = _utilizationBps();
        if (u <= uint256(KINK_BPS)) {
            return uint256(BASE_RATE_BPS) + (uint256(SLOPE1_BPS) * u) / uint256(KINK_BPS);
        }
        uint256 over = u - uint256(KINK_BPS);
        uint256 denom = uint256(BPS) - uint256(KINK_BPS);
        return uint256(BASE_RATE_BPS) + uint256(SLOPE1_BPS) + (uint256(SLOPE2_BPS) * over) / denom;
    }

    /// @notice Current annual supply (LP) rate in bps = borrowRate · utilization · (1 − reserveFactor).
    function currentSupplyRateBps() external view returns (uint256) {
        uint256 u = _utilizationBps();
        return ((currentBorrowRateBps() * u) / uint256(BPS)) * (uint256(BPS) - uint256(RESERVE_FACTOR_BPS))
            / uint256(BPS);
    }

    /// @notice Supply index forward-projected to now (mirror of currentIndexBps for LP display).
    function currentSupplyIndexBps() public view returns (uint256) {
        uint256 si = supplyIndexBps == 0 ? uint256(BPS) : supplyIndexBps;
        uint256 dt = block.timestamp - indexUpdatedAt;
        if (dt == 0 || totalLpSupplied == 0) return si;
        uint256 u = _utilizationBps();
        if (u == 0) return si;
        uint256 supplyRate =
            (((currentBorrowRateBps() * u) / uint256(BPS)) * (uint256(BPS) - uint256(RESERVE_FACTOR_BPS))) / uint256(BPS);
        return si + (si * supplyRate * dt) / (uint256(BPS) * SECONDS_PER_YEAR);
    }

    /// @notice An LP's claimable USDC (whole USDC), principal + accrued yield.
    function lpBalanceOf(address who) external view returns (uint256) {
        return (lpShares[who] * currentSupplyIndexBps()) / uint256(BPS);
    }

    /// @notice Total USDC owed to all LPs (whole USDC), principal + accrued yield.
    function totalSuppliedUsdc() external view returns (uint256) {
        return (totalLpSupplied * currentSupplyIndexBps()) / uint256(BPS);
    }

    /// @notice True if the cached oracle price is older than the staleness window.
    function isPriceStale() public view returns (bool) {
        return block.timestamp - priceUpdatedAt > STALENESS;
    }

    /// @notice Weekend circuit breaker — Fri 21:00 UTC → Mon 13:30 UTC (PRD §3.4).
    function isWeekendMode() public view returns (bool) {
        if (weekendOverride) return false; // testnet bypass
        uint256 epochDays = block.timestamp / 86_400;
        uint256 dow = (epochDays + 4) % 7;
        uint256 mins = (block.timestamp % 86_400) / 60;
        if (dow == 6 || dow == 0) return true;
        if (dow == 5 && mins >= 21 * 60) return true;
        if (dow == 1 && mins < 13 * 60 + 30) return true;
        return false;
    }

    /// @notice TESTNET ONLY — bypass the weekend circuit-breaker so borrow can be tested
    ///         off market-hours. (GOVERNOR_ROLE; would not exist on a production deploy.)
    function setWeekendOverride(bool v) external onlyRole(GOVERNOR_ROLE) {
        weekendOverride = v;
    }

    /// @notice Configure the Chainlink L2 sequencer-uptime feed + restart grace (GOVERNOR).
    ///         feed = address(0) disables the check (testnet); set on Arbitrum mainnet.
    function setSequencerFeed(address feed, uint256 grace) external onlyRole(GOVERNOR_ROLE) {
        sequencerUptimeFeed = feed;
        sequencerGracePeriod = grace;
    }

    /// @dev Revert if the L2 sequencer is down or still within its restart grace window.
    function _requireSequencerUp() internal view {
        address f = sequencerUptimeFeed;
        if (f == address(0)) return; // unset → testnet, skip
        (, int256 answer, uint256 startedAt,,) = ISequencerFeed(f).latestRoundData();
        if (answer != 0 || block.timestamp - startedAt <= sequencerGracePeriod) revert SequencerDown();
    }

    // ----------------------------------------------------------- USDC liquidity (LP)

    /// @notice Supply USDC liquidity for borrowers to draw. Public + plaintext (the confidential
    ///         side is the borrower's collateral/debt). Mints supply-index-scaled shares so the
    ///         deposit earns its pro-rata slice of borrow interest (Batch C LP yield).
    function provideLiquidity(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0 || amount > type(uint64).max) revert BadAmount();
        _accrue(); // settle the index up to now before minting shares
        uint256 si = supplyIndexBps == 0 ? uint256(BPS) : supplyIndexBps;
        usdc.safeTransferFrom(msg.sender, address(this), amount * USDC_UNIT);
        uint256 scaled = (amount * uint256(BPS)) / si;
        lpShares[msg.sender] += scaled;
        totalLpSupplied += scaled;
        emit LiquidityProvided(msg.sender, amount);
    }

    /// @notice Withdraw supplied USDC + accrued yield (bounded by your balance and the pool's
    ///         free USDC). `amount` is whole USDC; shares burned = amount·BPS/supplyIndex.
    ///         Allowed even when paused so LPs can always exit.
    function withdrawLiquidity(uint256 amount) external nonReentrant {
        if (amount == 0) revert BadAmount();
        _accrue();
        uint256 si = supplyIndexBps == 0 ? uint256(BPS) : supplyIndexBps;
        uint256 scaled = (amount * uint256(BPS)) / si;
        if (scaled == 0 || scaled > lpShares[msg.sender]) revert BadAmount();
        if (amount * USDC_UNIT > usdc.balanceOf(address(this))) revert InsufficientLiquidity();
        lpShares[msg.sender] -= scaled;
        totalLpSupplied -= scaled;
        usdc.safeTransfer(msg.sender, amount * USDC_UNIT);
        emit LiquidityWithdrawn(msg.sender, amount);
    }

    /// @notice Governance: withdraw accrued protocol reserve (micro-USDC) to the treasury.
    function withdrawReserve(address to, uint256 microAmount) external onlyRole(GOVERNOR_ROLE) {
        if (to == address(0) || microAmount == 0 || microAmount > reserveAccruedUsdc) revert BadAmount();
        if (microAmount > usdc.balanceOf(address(this))) revert InsufficientLiquidity();
        reserveAccruedUsdc -= microAmount;
        usdc.safeTransfer(to, microAmount);
        emit ReserveWithdrawn(to, microAmount);
    }

    /// @notice USDC currently available (free) in the pool, in whole USDC.
    function availableLiquidity() external view returns (uint256) {
        return usdc.balanceOf(address(this)) / USDC_UNIT;
    }

    // --------------------------------------------------------------- onboarding

    /// @notice Set the secret blinding `s` (sealed), clamped homomorphically to >= 1.
    function initBlinding(InEuint64 calldata encS) external whenNotPaused onlyKyc {
        if (initialized[msg.sender]) revert AlreadyInitialized();
        euint64 s = FHE.asEuint64(encS);
        ebool isZero = FHE.lt(s, FHE.asEuint64(1));
        s = FHE.select(isZero, FHE.asEuint64(1), s);

        _eBlinding[msg.sender] = s;
        _eCollateral[msg.sender] = FHE.asEuint64(0);
        _eScaledDebt[msg.sender] = FHE.asEuint64(0);
        _eShareCredit[msg.sender] = FHE.asEuint64(0);
        _eUsdcCredit[msg.sender] = FHE.asEuint64(0);
        FHE.allowThis(s);
        FHE.allowSender(s);
        FHE.allowThis(_eCollateral[msg.sender]);
        FHE.allowSender(_eCollateral[msg.sender]); // let the owner client-decrypt their own position
        FHE.allowThis(_eScaledDebt[msg.sender]);
        FHE.allowSender(_eScaledDebt[msg.sender]);
        FHE.allowThis(_eShareCredit[msg.sender]);
        FHE.allowSender(_eShareCredit[msg.sender]);
        FHE.allowThis(_eUsdcCredit[msg.sender]);
        FHE.allowSender(_eUsdcCredit[msg.sender]);
        initialized[msg.sender] = true;
        emit BlindingSet(msg.sender);
        _recomputeFactors(msg.sender);
    }

    // ------------------------------------------------------- plaintext token edges

    /// @notice EDGE (plaintext, position-decoupled): deposit real dShares into a sealed
    ///         idle credit. The amount is public here; allocate it to collateral later
    ///         via `deposit(InEuint64)` in a sealed amount of your choosing.
    function fundShares(uint256 shares) external whenNotPaused nonReentrant onlyKyc {
        if (!initialized[msg.sender]) revert NotInitialized();
        if (shares == 0 || shares > type(uint64).max) revert BadAmount();
        dShares.safeTransferFrom(msg.sender, address(this), shares * DSHARE_UNIT);
        euint64 bal = FHE.add(_eShareCredit[msg.sender], FHE.asEuint64(shares));
        _eShareCredit[msg.sender] = bal;
        FHE.allowThis(bal);
        FHE.allowSender(bal);
        emit SharesFunded(msg.sender, shares);
    }

    /// @notice EDGE (plaintext, position-decoupled): deposit real USDC into a sealed idle
    ///         credit (used to repay or to fund liquidations confidentially, or to be
    ///         withdrawn later). Amount public here.
    function fundUsdc(uint256 amount) external whenNotPaused nonReentrant onlyKyc {
        if (!initialized[msg.sender]) revert NotInitialized();
        if (amount == 0 || amount > type(uint64).max) revert BadAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount * USDC_UNIT);
        euint64 bal = FHE.add(_eUsdcCredit[msg.sender], FHE.asEuint64(amount));
        _eUsdcCredit[msg.sender] = bal;
        FHE.allowThis(bal);
        FHE.allowSender(bal);
        emit UsdcFunded(msg.sender, amount);
    }

    /// @notice EDGE (plaintext payout, async): burn a sealed amount of idle share- or
    ///         USDC-credit now; the (clamped) amount is threshold-decrypted and paid out
    ///         in `claimWithdraw`. The payout amount is necessarily public.
    function requestWithdraw(InEuint64 calldata encAmount, bool isUsdc)
        external
        whenNotPaused
        nonReentrant
        onlyKyc
        returns (uint256 withdrawId)
    {
        if (!initialized[msg.sender]) revert NotInitialized();
        euint64 amt = FHE.asEuint64(encAmount);
        euint64 src = isUsdc ? _eUsdcCredit[msg.sender] : _eShareCredit[msg.sender];
        euint64 take = FHE.min(amt, src);
        euint64 remaining = FHE.sub(src, take);
        if (isUsdc) {
            _eUsdcCredit[msg.sender] = remaining;
        } else {
            _eShareCredit[msg.sender] = remaining;
        }
        FHE.allowThis(remaining);
        FHE.allowSender(remaining);

        FHE.allowThis(take);
        FHE.allowPublic(take);
        withdrawals.push(Withdrawal({owner: msg.sender, amount: take, isUsdc: isUsdc, claimed: false}));
        withdrawId = withdrawals.length - 1;
        emit WithdrawRequested(msg.sender, withdrawId, isUsdc);
    }

    /// @notice Pay out a withdrawal once its sealed amount has been decrypted.
    function claimWithdraw(uint256 withdrawId, uint64 amount, bytes calldata proof) external nonReentrant {
        Withdrawal storage w = withdrawals[withdrawId];
        if (w.owner != msg.sender) revert NotOwner();
        if (w.claimed) revert AlreadyClaimed();
        // CoFHE 0.1.x: the sealed amount is threshold-decrypted off-chain; the caller
        // submits (amount, proof) and the coprocessor signature is verified on-chain.
        if (!FHE.verifyDecryptResult(w.amount, amount, proof)) revert DecryptionPending();
        w.claimed = true;
        if (amount > 0) {
            if (w.isUsdc) {
                usdc.safeTransfer(msg.sender, uint256(amount) * USDC_UNIT);
            } else {
                dShares.safeTransfer(msg.sender, uint256(amount) * DSHARE_UNIT);
            }
        }
        emit WithdrawClaimed(msg.sender, withdrawId, w.isUsdc, amount);
    }

    // ---------------------------------------------------------------- collateral

    /// @notice Move a SEALED amount of idle share-credit into collateral (confidential).
    function deposit(InEuint64 calldata encShares) external whenNotPaused nonReentrant onlyKyc {
        if (!initialized[msg.sender]) revert NotInitialized();
        euint64 amt = FHE.asEuint64(encShares);
        euint64 move = FHE.min(amt, _eShareCredit[msg.sender]);

        euint64 newCredit = FHE.sub(_eShareCredit[msg.sender], move);
        _eShareCredit[msg.sender] = newCredit;
        FHE.allowThis(newCredit);
        FHE.allowSender(newCredit);

        euint64 newColl = FHE.add(_eCollateral[msg.sender], move);
        _eCollateral[msg.sender] = newColl;
        FHE.allowThis(newColl);
        FHE.allowSender(newColl);

        emit Deposited(msg.sender);
        _recomputeFactors(msg.sender);
    }

    // -------------------------------------------------------------------- borrow

    /// @notice Confidential borrow (synchronous — no public decrypt). Over-limit draws 0
    ///         via homomorphic clamp. AUDIT EQX-01: gated on *remaining* capacity
    ///         (eMax − currentDebt), not the full LTV cap. AUDIT EQX-06: all products in
    ///         euint128 to avoid silent modular overflow. Proceeds are credited to the
    ///         sealed `_eUsdcCredit` (EQX-02: no plaintext disbursement) — realize them as
    ///         real USDC later via `requestWithdraw(..., true)`.
    function requestBorrow(InEuint64 calldata encR) external whenNotPaused nonReentrant onlyKyc {
        if (!initialized[msg.sender]) revert NotInitialized();
        _requireSequencerUp();
        if (isWeekendMode()) revert WeekendBreaker();
        if (isPriceStale()) revert StaleOracle();
        _accrue();
        uint256 idx = storedIndexBps;

        euint128 c = FHE.asEuint128(_eCollateral[msg.sender]);
        euint128 eMax = FHE.div(
            FHE.mul(FHE.mul(c, FHE.asEuint128(uint256(price))), FHE.asEuint128(uint256(LTV_BPS))),
            FHE.asEuint128(uint256(BPS))
        ); // C·price·LTV/BPS
        euint128 eDebt =
            FHE.div(FHE.mul(FHE.asEuint128(_eScaledDebt[msg.sender]), FHE.asEuint128(idx)), FHE.asEuint128(uint256(BPS))); // scaledDebt·idx/BPS
        ebool hasRoom = FHE.lte(eDebt, eMax);
        euint128 eRoom = FHE.select(hasRoom, FHE.sub(eMax, eDebt), FHE.asEuint128(uint256(0)));

        euint128 r = FHE.asEuint128(FHE.asEuint64(encR));
        // PRD semantics preserved: an over-(remaining-)limit request draws 0, no revert.
        euint128 approved128 = FHE.select(FHE.lte(r, eRoom), r, FHE.asEuint128(uint256(0)));
        euint64 approved = FHE.asEuint64(approved128); // ≤ r ≤ uint64 max

        // scaledAdd = ceil(approved·BPS / idx)
        euint128 scaledAdd128 = FHE.div(
            FHE.add(FHE.mul(approved128, FHE.asEuint128(uint256(BPS))), FHE.asEuint128(idx - 1)), FHE.asEuint128(idx)
        );
        euint64 newScaled = FHE.add(_eScaledDebt[msg.sender], FHE.asEuint64(scaledAdd128));
        _eScaledDebt[msg.sender] = newScaled;
        FHE.allowThis(newScaled);
        FHE.allowSender(newScaled);

        euint64 newCredit = FHE.add(_eUsdcCredit[msg.sender], approved);
        _eUsdcCredit[msg.sender] = newCredit;
        FHE.allowThis(newCredit);
        FHE.allowSender(newCredit);

        emit BorrowRequested(msg.sender);
        _recomputeFactors(msg.sender);
    }

    // --------------------------------------------------------------------- repay

    /// @notice Confidential repay from sealed USDC credit. Reduces the *current*
    ///         (interest-inclusive) debt by scaling the repayment down by the live index;
    ///         only the USDC actually applied to debt is consumed (no overpayment burn).
    function repay(InEuint64 calldata encAmount) external whenNotPaused nonReentrant onlyKyc {
        if (!initialized[msg.sender]) revert NotInitialized();
        _accrue();
        uint256 idx = storedIndexBps;

        euint64 amt = FHE.asEuint64(encAmount);
        euint64 pay = FHE.min(amt, _eUsdcCredit[msg.sender]); // can't repay more credit than held

        euint128 scaledSub128 =
            FHE.div(FHE.mul(FHE.asEuint128(pay), FHE.asEuint128(uint256(BPS))), FHE.asEuint128(idx));
        euint128 scaledPaid128 = FHE.min(scaledSub128, FHE.asEuint128(_eScaledDebt[msg.sender]));
        euint64 scaledPaid = FHE.asEuint64(scaledPaid128);

        // USDC actually consumed = scaledPaid·idx/BPS (≤ pay), so overpayment stays as credit.
        euint128 usedRaw = FHE.div(FHE.mul(scaledPaid128, FHE.asEuint128(idx)), FHE.asEuint128(uint256(BPS)));
        euint64 used = FHE.asEuint64(FHE.min(usedRaw, FHE.asEuint128(pay)));

        euint64 newScaled = FHE.sub(_eScaledDebt[msg.sender], scaledPaid);
        _eScaledDebt[msg.sender] = newScaled;
        FHE.allowThis(newScaled);
        FHE.allowSender(newScaled);

        euint64 newCredit = FHE.sub(_eUsdcCredit[msg.sender], used);
        _eUsdcCredit[msg.sender] = newCredit;
        FHE.allowThis(newCredit);
        FHE.allowSender(newCredit);

        emit Repaid(msg.sender);
        _recomputeFactors(msg.sender);
    }

    // ------------------------------------------------------- blinded public factors

    function _recomputeFactors(address user) internal {
        // euint128 products (AUDIT EQX-06): s·C·LT and s·scaledDebt cannot silently wrap,
        // and decrypt to their true value regardless of a user-chosen large blinding s.
        euint128 eA = FHE.mul(
            FHE.mul(FHE.asEuint128(_eBlinding[user]), FHE.asEuint128(_eCollateral[user])), FHE.asEuint128(uint256(LT_BPS))
        );
        euint128 eB = FHE.mul(FHE.asEuint128(_eBlinding[user]), FHE.asEuint128(_eScaledDebt[user]));
        FHE.allowThis(eA);
        FHE.allowThis(eB);
        // CoFHE 0.1.x: make the blinded factors publicly decryptable (the threshold
        // network decrypts off-chain). Replaces the removed FHE.decrypt request.
        FHE.allowPublic(eA);
        FHE.allowPublic(eB);
        _eA[user] = eA;
        _eB[user] = eB;
        // AUDIT EQX-04: only the *latest* poke is marked not-ready; the last *settled*
        // factorA/factorB (and factorsSettledOnce) are retained so liquidation cannot be
        // blocked by repeatedly invalidating this flag.
        factorsReady[user] = false;
    }

    /// @notice Settle a user's PUBLIC blinded factors (A,B) from off-chain threshold
    ///         decryption + coprocessor proofs (CoFHE 0.1.x — the old on-chain poll is dead).
    ///         Permissionless: any keeper/liquidator can settle so HF becomes computable.
    ///         Proofs are verified against the publicly-decryptable eA/eB handles.
    function settleFactors(address user, uint128 a, uint128 b, bytes calldata proofA, bytes calldata proofB) external {
        if (!FHE.verifyDecryptResult(_eA[user], a, proofA)) revert DecryptionPending();
        if (!FHE.verifyDecryptResult(_eB[user], b, proofB)) revert DecryptionPending();
        factorA[user] = a;
        factorB[user] = b;
        factorsReady[user] = true;
        factorsSettledOnce[user] = true;
        factorsAt[user] = block.timestamp;
        emit FactorsUpdated(user, a, b);
    }

    /// @notice Publicly-decryptable ciphertext handles of a user's blinded factors A,B
    ///         (threshold-decrypt off-chain → settleFactors).
    function encryptedFactorsOf(address user) external view returns (uint256 eA, uint256 eB) {
        return (uint256(euint128.unwrap(_eA[user])), uint256(euint128.unwrap(_eB[user])));
    }

    /// @notice Public health factor in bps: HF = (A·P·1e4·[weekend haircut])/(B·index).
    ///         B = s·scaledDebt, so B·index ∝ s·currentDebt — the secret `s` cancels.
    /// @dev    Uses the last *settled* factors (EQX-04) with the *live* price and index, so
    ///         worsening from price drops / interest is reflected without a re-poke. A view
    ///         — never reverts on stale price (UIs read it); the staleness guard lives on
    ///         the state-changing liquidation entrypoint instead (EQX-03).
    function healthFactorBps(address user) public view returns (uint256) {
        if (!factorsSettledOnce[user]) revert FactorsNotSettled();
        if (factorB[user] == 0) return type(uint256).max;
        uint256 num = factorA[user] * uint256(price) * uint256(BPS);
        if (isWeekendMode()) {
            num = (num * (uint256(BPS) - uint256(HAIRCUT_BPS))) / uint256(BPS);
        }
        return num / (factorB[user] * currentIndexBps());
    }

    // ----------------------------------------------------------------- liquidate

    /// @notice Confidential, single-step liquidation (synchronous — no public decrypt).
    ///         The repay is drawn from the liquidator's sealed USDC credit (fund it first
    ///         via `fundUsdc`) and capped homomorphically to CLOSE_FACTOR of the sealed
    ///         current debt, so the liquidator can never overpay. Victim debt is reduced
    ///         and collateral + bonus seized to the liquidator — all in the sealed domain.
    /// @dev    AUDIT EQX-03 staleness guard; EQX-04 gates on factorsSettledOnce (not the
    ///         resettable factorsReady); EQX-05 re-grants the victim decrypt-ACL on their
    ///         rewritten balances; EQX-12(a) reduces debt at the LIVE index.
    function liquidate(address user, InEuint64 calldata encRepayUsdc) external whenNotPaused nonReentrant onlyKyc {
        if (!initialized[msg.sender]) revert NotInitialized();
        if (!factorsSettledOnce[user]) revert FactorsNotSettled();
        _requireSequencerUp();
        if (isPriceStale()) revert StaleOracle();
        if (healthFactorBps(user) >= uint256(BPS)) revert Healthy();
        _accrue();
        uint256 idx = storedIndexBps;

        // maxRepay = currentDebt·CF = scaledDebt·idx·CF / (BPS·BPS)
        euint128 maxRepay = FHE.div(
            FHE.mul(FHE.asEuint128(_eScaledDebt[user]), FHE.asEuint128(idx * uint256(CLOSE_FACTOR_BPS))),
            FHE.asEuint128(uint256(BPS) * uint256(BPS))
        );
        euint128 req = FHE.asEuint128(FHE.asEuint64(encRepayUsdc));
        euint128 capped = FHE.min(FHE.min(req, maxRepay), FHE.asEuint128(_eUsdcCredit[msg.sender]));
        euint64 ePay = FHE.asEuint64(capped); // ≤ liquidator credit ≤ uint64 max

        // reduce victim scaled debt by the repaid amount (LIVE index — EQX-12a)
        euint128 scaledSub = FHE.div(FHE.mul(capped, FHE.asEuint128(uint256(BPS))), FHE.asEuint128(idx));
        euint64 paid = FHE.asEuint64(FHE.min(scaledSub, FHE.asEuint128(_eScaledDebt[user])));
        euint64 newVictimDebt = FHE.sub(_eScaledDebt[user], paid);
        _eScaledDebt[user] = newVictimDebt;
        FHE.allowThis(newVictimDebt);
        FHE.allow(newVictimDebt, user); // EQX-05: victim keeps decrypt-ACL on own debt

        // seize = ePay·(1+bonus)/price (sealed), clamped to victim collateral
        euint128 seize = FHE.div(
            FHE.mul(capped, FHE.asEuint128(uint256(BPS) + uint256(LIQ_BONUS_BPS))),
            FHE.asEuint128(uint256(BPS) * uint256(price))
        );
        euint64 take = FHE.asEuint64(FHE.min(seize, FHE.asEuint128(_eCollateral[user])));
        euint64 newVictimColl = FHE.sub(_eCollateral[user], take);
        _eCollateral[user] = newVictimColl;
        FHE.allowThis(newVictimColl);
        FHE.allow(newVictimColl, user); // EQX-05: victim keeps decrypt-ACL on own collateral

        euint64 liqColl = FHE.add(_eCollateral[msg.sender], take);
        _eCollateral[msg.sender] = liqColl;
        FHE.allowThis(liqColl);
        FHE.allowSender(liqColl);

        euint64 liqCredit = FHE.sub(_eUsdcCredit[msg.sender], ePay);
        _eUsdcCredit[msg.sender] = liqCredit;
        FHE.allowThis(liqCredit);
        FHE.allowSender(liqCredit);

        liquidated[user] = true;
        _recomputeFactors(user);
        _recomputeFactors(msg.sender);
        emit Liquidated(user, msg.sender);
    }

    // --------------------------------------------------------------------- admin

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // --------------------------------------------------------------------- views

    function encryptedCollateralOf(address user) external view returns (euint64) {
        return _eCollateral[user];
    }

    function encryptedScaledDebtOf(address user) external view returns (euint64) {
        return _eScaledDebt[user];
    }

    function encryptedShareCreditOf(address user) external view returns (euint64) {
        return _eShareCredit[user];
    }

    function encryptedUsdcCreditOf(address user) external view returns (euint64) {
        return _eUsdcCredit[user];
    }

    function getFactors(address user) external view returns (uint256 a, uint256 b, bool ready) {
        return (factorA[user], factorB[user], factorsReady[user]);
    }

    function withdrawalsCount() external view returns (uint256) {
        return withdrawals.length;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}
