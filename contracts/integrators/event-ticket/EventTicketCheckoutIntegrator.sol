// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { ICheckoutClient } from "../../interfaces/ICheckoutClient.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title EventTicketCheckoutIntegrator
 * @notice Sample integrator for event-ticket sales: a user pays local fiat
 *         (UPI / PIX / SPEI) through the P2P Diamond and the event organiser's
 *         `ICheckoutClient` mints them ERC-721 tickets once fiat settles.
 *
 *         The standard flow is identical to `ExampleIntegrator`. The one
 *         app-specific invariant this integrator adds — the thing that
 *         justifies it existing as its own contract rather than a config of
 *         the Example one — is an **anti-scalping per-event ticket cap**:
 *
 *           ticketsHeld[client][eventId][user] + quantity <= maxTicketsPerEvent
 *
 *         The cap is a *consumable*: it is debited at `userPlaceOrder` time
 *         (so a user cannot park N pending orders to sidestep it) and
 *         released again in `onOrderCancel`. That is exactly the consumable
 *         lifecycle `docs/ARCHITECTURE.md` describes for the daily-count
 *         debit — this integrator just swaps the unit from "orders per day"
 *         to "tickets per event", which is the limit shape a ticketing
 *         business actually cares about.
 *
 *         `productId` is interpreted as the organiser's `eventId`.
 *
 * @dev    Custody follows the standard shape: the integrator is registered
 *         with `usdcThroughIntegrator = true` and passes itself as
 *         `recipientAddr`, so completion routes USDC here and
 *         `onOrderComplete` forwards it to the client. The per-user
 *         `UserProxy` is a placement vehicle only (it is `msg.sender` to the
 *         Diamond, which is what the Diamond's CREATE2-auth path expects).
 */
contract EventTicketCheckoutIntegrator is IP2PIntegrator {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    error InvalidQuantity();
    error InvalidCap();
    error ClientNotRegistered();
    error EventNotFound();
    error TxLimitExceeded();
    error TicketCapExceeded();
    error UnknownOrder();
    error OrderAlreadyFulfilled();
    error OrderAlreadyCancelled();

    // ─── Events ───────────────────────────────────────────────────────

    event TicketOrderPlaced(
        uint256 indexed orderId,
        address indexed user,
        address indexed client,
        uint256 eventId,
        uint256 quantity,
        uint256 totalUsdcAmount
    );
    event TicketOrderFulfilled(
        uint256 indexed orderId,
        address indexed user,
        address indexed client,
        uint256 eventId,
        uint256 quantity
    );
    event TicketOrderCancelled(
        uint256 indexed orderId,
        address indexed user,
        address indexed client,
        uint256 eventId,
        uint256 quantity
    );
    event OrganiserRegistered(address indexed client);
    event OrganiserRemoved(address indexed client);
    event BaseTxLimitUpdated(uint256 limit);
    event MaxTicketsPerEventUpdated(uint256 cap);
    event UserProxyDeployed(address indexed user, address proxy);

    // ─── Immutables ───────────────────────────────────────────────────

    address public immutable diamond;
    /// @notice Public getter is required — the canonical `UserProxy` resolves
    ///         the blocked-sweep token via `IUsdcSource(integrator()).usdc()`.
    IERC20 public immutable usdc;
    address public immutable owner;
    /// @notice Pinned at deploy. Submit alongside the integrator address in
    ///         the whitelist request so the Diamond can register it for the
    ///         CREATE2-auth path.
    address public immutable proxyImpl;

    // ─── Config ───────────────────────────────────────────────────────

    /// @notice Max USDC (6dp) a single order may be worth.
    uint256 public baseTxLimit;
    /// @notice Max tickets one user may hold for one event, across all orders.
    uint256 public maxTicketsPerEvent;

    // ─── State ────────────────────────────────────────────────────────

    struct TicketOrder {
        address user; // 20 bytes ─┐
        bool fulfilled; //  1 byte  ├─ one slot
        bool cancelled; //  1 byte ─┘
        address client;
        uint256 eventId;
        uint256 quantity;
        uint256 usdcAmount;
    }

    mapping(address => bool) public organisers;
    mapping(uint256 => TicketOrder) public orders;
    /// @dev client => eventId => user => tickets reserved or owned.
    mapping(address => mapping(uint256 => mapping(address => uint256))) public ticketsHeld;

    // ─── Modifiers ────────────────────────────────────────────────────

    modifier onlyDiamond() {
        if (msg.sender != diamond) revert OnlyDiamond();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────

    /// @param _diamond            P2P Diamond address.
    /// @param _usdc               USDC on the target chain (6 decimals).
    /// @param _baseTxLimit        Per-order USDC ceiling.
    /// @param _maxTicketsPerEvent Per-user, per-event ticket cap.
    constructor(
        address _diamond,
        address _usdc,
        uint256 _baseTxLimit,
        uint256 _maxTicketsPerEvent
    ) {
        if (_diamond == address(0) || _usdc == address(0)) revert InvalidAddress();
        if (_maxTicketsPerEvent == 0) revert InvalidCap();
        diamond = _diamond;
        usdc = IERC20(_usdc);
        owner = msg.sender;
        baseTxLimit = _baseTxLimit;
        maxTicketsPerEvent = _maxTicketsPerEvent;
        proxyImpl = address(new UserProxy());
    }

    // ─── Admin ────────────────────────────────────────────────────────

    /// @notice Allow an organiser's `ICheckoutClient` to be checked out against.
    function registerOrganiser(address client) external onlyOwner {
        if (client == address(0)) revert InvalidAddress();
        organisers[client] = true;
        emit OrganiserRegistered(client);
    }

    /// @notice Stop new orders against an organiser. In-flight orders still settle.
    function removeOrganiser(address client) external onlyOwner {
        organisers[client] = false;
        emit OrganiserRemoved(client);
    }

    /// @notice Update the per-order USDC ceiling.
    function setBaseTxLimit(uint256 limit) external onlyOwner {
        baseTxLimit = limit;
        emit BaseTxLimitUpdated(limit);
    }

    /// @notice Update the per-user, per-event ticket cap.
    function setMaxTicketsPerEvent(uint256 cap) external onlyOwner {
        if (cap == 0) revert InvalidCap();
        maxTicketsPerEvent = cap;
        emit MaxTicketsPerEventUpdated(cap);
    }

    // ─── User-facing order placement ──────────────────────────────────

    /**
     * @notice Buy `quantity` tickets for `eventId` from `client`, paying in
     *         `currency` fiat. Total cost = unitPrice × quantity.
     * @dev    Signature matches the V2 shape the `@p2pdotme/widgets`
     *         `<Checkout>` host callback encodes, so the widget's reference
     *         `INTEGRATOR_ABI` works against this contract unchanged.
     * @param client    Organiser's `ICheckoutClient`.
     * @param eventId   Product id on the client — the event being ticketed.
     * @param quantity  Number of tickets.
     * @param currency  bytes32 fiat code, e.g. `stringToHex("INR", {size:32})`.
     * @param circleId  Merchant circle to route to (0 = SDK-routed upstream).
     * @param pubKey    User's relay pubkey; merchant encrypts payment details to it.
     * @param preferredPaymentChannelConfigId 0 = no preference.
     * @param fiatAmountLimit                 0 = no slippage check.
     * @return orderId  Diamond order id.
     */
    function userPlaceOrder(
        address client,
        uint256 eventId,
        uint256 quantity,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external returns (uint256 orderId) {
        if (!organisers[client]) revert ClientNotRegistered();
        if (quantity == 0) revert InvalidQuantity();

        uint256 unitPrice = ICheckoutClient(client).getProductPrice(eventId);
        if (unitPrice == 0) revert EventNotFound();

        uint256 totalPrice = unitPrice * quantity;
        if (totalPrice > baseTxLimit) revert TxLimitExceeded();

        // Debit the consumable BEFORE placing. Reserving here (rather than at
        // fulfillment) is what stops a user opening N concurrent orders that
        // each pass the cap individually but breach it together.
        uint256 held = ticketsHeld[client][eventId][msg.sender];
        if (held + quantity > maxTicketsPerEvent) revert TicketCapExceeded();
        ticketsHeld[client][eventId][msg.sender] = held + quantity;

        // The Diamond's B2B gateway is proxy-only: the user's UserProxy must
        // be `msg.sender` so the gateway can re-derive the CREATE2 address
        // from our pinned proxyImpl. `usdcAllowance = 0` — placement pulls no
        // USDC; fiat settles off-chain.
        address proxy = _ensureProxy(msg.sender);
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (
                msg.sender,
                totalPrice,
                currency,
                address(this),
                pubKey,
                circleId,
                preferredPaymentChannelConfigId,
                fiatAmountLimit
            )
        );
        bytes memory result = UserProxy(proxy).execute(diamond, data, address(usdc), 0);
        orderId = abi.decode(result, (uint256));

        orders[orderId] = TicketOrder({
            user: msg.sender,
            fulfilled: false,
            cancelled: false,
            client: client,
            eventId: eventId,
            quantity: quantity,
            usdcAmount: totalPrice
        });

        emit TicketOrderPlaced(orderId, msg.sender, client, eventId, quantity, totalPrice);
    }

    // ─── IP2PIntegrator callbacks ─────────────────────────────────────

    /// @notice Diamond-side limit check at `placeB2BOrder` time. Stateless
    ///         here: the ticket cap was already debited in `userPlaceOrder`
    ///         (same transaction), so this only re-asserts the USDC ceiling.
    function validateOrder(
        address /* user */,
        uint256 amount,
        bytes32 /* currency */
    ) external onlyDiamond returns (bool allowed) {
        return amount <= baseTxLimit;
    }

    /// @notice Fiat settled — forward USDC to the organiser and have them mint.
    function onOrderComplete(
        uint256 orderId,
        address /* user */,
        uint256 amount,
        address /* recipientAddr */
    ) external onlyDiamond {
        TicketOrder storage o = orders[orderId];
        if (o.user == address(0)) revert UnknownOrder();
        if (o.fulfilled) revert OrderAlreadyFulfilled();
        if (o.cancelled) revert OrderAlreadyCancelled();

        // Effects before interactions — a re-entrant callback finds `fulfilled`.
        o.fulfilled = true;

        usdc.safeTransfer(o.client, amount);
        ICheckoutClient(o.client).onCheckoutPayment(o.user, amount, o.eventId, o.quantity);

        emit TicketOrderFulfilled(orderId, o.user, o.client, o.eventId, o.quantity);
    }

    /// @notice Order died (expiry / dispute / manual) — release the reserved
    ///         tickets so the user can try again.
    /// @dev    Best-effort from the gateway's POV: tolerate an unknown orderId
    ///         rather than reverting, since protocol-side state has already
    ///         finalised by the time this fires.
    function onOrderCancel(uint256 orderId) external onlyDiamond {
        TicketOrder storage o = orders[orderId];
        if (o.user == address(0)) return;
        if (o.fulfilled) revert OrderAlreadyFulfilled();
        if (o.cancelled) revert OrderAlreadyCancelled();
        o.cancelled = true;

        uint256 held = ticketsHeld[o.client][o.eventId][o.user];
        ticketsHeld[o.client][o.eventId][o.user] = held > o.quantity ? held - o.quantity : 0;

        emit TicketOrderCancelled(orderId, o.user, o.client, o.eventId, o.quantity);
    }

    // ─── Views ────────────────────────────────────────────────────────

    /// @notice Tickets `user` may still buy for `eventId` from `client`.
    function ticketsRemaining(
        address user,
        address client,
        uint256 eventId
    ) external view returns (uint256) {
        uint256 held = ticketsHeld[client][eventId][user];
        if (held >= maxTicketsPerEvent) return 0;
        return maxTicketsPerEvent - held;
    }

    /// @notice Full order record for `orderId`.
    function getOrder(uint256 orderId) external view returns (TicketOrder memory) {
        return orders[orderId];
    }

    /// @notice Deterministic `UserProxy` address for `user`. May not be
    ///         deployed yet — check `code.length` if that matters.
    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    // ─── Internal: proxy helpers (canonical layout — do not change) ───

    function _salt(address user) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(user)));
    }

    /// @dev Immutable args layout: [owner(20)][integrator(20)] — 40 bytes.
    function _proxyArgs(address user) internal view returns (bytes memory) {
        return abi.encodePacked(user, address(this));
    }

    function _ensureProxy(address user) internal returns (address proxy) {
        proxy = proxyAddress(user);
        if (proxy.code.length == 0) {
            address deployed = Clones.cloneDeterministicWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user)
            );
            assert(deployed == proxy);
            emit UserProxyDeployed(user, proxy);
        }
    }
}
