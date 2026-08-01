# EventTicketCheckoutIntegrator

**Sample integrator — not deployed, not whitelisted.** Written as a walkthrough
of the full P2P B2B checkout path: a user pays local fiat, an event organiser
receives USDC on Base, and the buyer's ERC-721 ticket mints itself.

## What it serves

An event organiser selling tickets to buyers who have local currency (UPI, PIX,
SPEI) but no crypto. `productId` is the organiser's `eventId`; `quantity` is the
number of tickets.

## What makes it its own integrator

The standard flow (register clients, per-tx limit, place through a `UserProxy`,
route USDC on completion) is identical to `ExampleIntegrator`. The one thing
that differs — and the answer to the question `ARCHITECTURE.md` says to ask,
*"what changes for me?"* — is the limit shape:

| | `ExampleIntegrator` | this one |
|---|---|---|
| Consumable | orders per user per UTC day | **tickets per user per event** |
| Debited at | `validateOrder` (Diamond callback) | `userPlaceOrder` (before placement) |
| Released at | `onOrderCancel` | `onOrderCancel` |

A ticketing business does not care how many times you bought today; it cares that
one person cannot buy out an event. So the consumable is
`ticketsHeld[client][eventId][user]`, capped by `maxTicketsPerEvent`.

**Reserving at placement, not at fulfillment, is the load-bearing decision.**
Fiat settlement is asynchronous — an order sits open for minutes. If the cap were
only checked against *completed* purchases, one user could open ten concurrent
orders that each pass the check individually and blow past the cap together.
Debiting up front makes pending orders count; `onOrderCancel` gives the tickets
back so a cancelled order costs the user nothing.

## Dependencies

None beyond the protocol. No third-party pricing, no async fulfillment, no
upstream protocol with its own inventory. The organiser is any contract
implementing `ICheckoutClient`; the tests use the repo's
`contracts/examples/SimpleERC721Client.sol` unchanged.

## Lifecycle

```
buyer                integrator              UserProxy          Diamond        organiser
  │ userPlaceOrder(client, eventId, qty, "INR", circleId, pubKey, 0, 0)
  ├───────────────────────▶│
  │             reserve qty tickets
  │             (revert TicketCapExceeded if over)
  │                        ├── clone (CREATE2) ──▶│
  │                        │                      ├── placeB2BOrder ──▶│
  │                        │                      │   validateOrder ◀──┤  (per-tx USDC cap)
  │                        │◀──────── orderId ────┴────────────────────┤
  │◀───────────────────────┤
  │
  │ ── pays fiat off-chain to the assigned merchant ──▶
  │    merchant ACCEPTED → buyer PAID → merchant COMPLETED
  │                        │                                           │
  │                        │◀──── onOrderComplete(orderId, …) ─────────┤
  │                        ├── safeTransfer(USDC) ────────────────────────────────▶│
  │                        ├── onCheckoutPayment(user, amt, eventId, qty) ────────▶│
  │◀──────────────────────────────────── ERC-721 tickets minted ───────────────────┤
```

On cancellation (expiry, dispute, manual) the Diamond calls `onOrderCancel` and
the reserved tickets are released.

## Custody

Standard shape — nothing exotic. Registered with `usdcThroughIntegrator = true`
and `recipientAddr = address(this)`, so completion routes USDC to the integrator
and `onOrderComplete` forwards it to the organiser in the same transaction. The
per-user `UserProxy` is a **placement vehicle only** (it must be `msg.sender` to
the Diamond for the CREATE2-auth path); it never holds USDC in the happy path, so
there is no credit-redemption or sweep path to implement.

## Limits

- **Per-tx**: flat `baseTxLimit` in USDC, enforced in `userPlaceOrder` (readable
  revert) and re-asserted in `validateOrder` (the Diamond's own check).
- **No RP curve.** A deliberate simplification for a sample — a production
  ticketing integrator would likely want `ExampleIntegrator`'s RP-scaled limit.
- **Per-event cap**: `maxTicketsPerEvent`, per user per event.

Both are owner-settable with no redeploy.

## Frontend wiring

`userPlaceOrder` deliberately keeps the 8-argument V2 shape, so the reference
`INTEGRATOR_ABI` in the `@p2pdotme/widgets` README works against it unchanged:

```ts
const placeOrder = async (ctx: PlaceOrderContext): Promise<PlaceOrderResult> => {
  const data = encodeFunctionData({
    abi: INTEGRATOR_ABI,
    functionName: "userPlaceOrder",
    args: [
      CLIENT_ADDRESS,
      EVENT_ID,
      QUANTITY,
      stringToHex(ctx.currency.symbol, { size: 32 }),
      ctx.currency.circleId!,   // resolved by the widget (SDK routing)
      identity.publicKey,
      0n,                        // preferredPaymentChannelConfigId
      0n,                        // fiatAmountLimit
    ],
  });
  const { hash } = await signer.sendTransaction({
    to: INTEGRATOR_ADDRESS, data, gasLimit: 1_500_000,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const orderId = parseOrderIdFromReceipt(receipt);
  if (!orderId) throw new Error("orderId missing from receipt");
  return { orderId, txHash: hash };
};
```

`ticketsRemaining(user, client, eventId)` is the view a host would read to grey
out the quantity picker before the user wastes a transaction on a revert.

## Operational notes

- Organisers are allowlisted (`registerOrganiser`). `removeOrganiser` stops new
  orders; in-flight orders still settle, because `onOrderComplete` reads the
  recorded order rather than re-checking registration.
- `onOrderComplete` sets `fulfilled` **before** transferring USDC
  (checks-effects-interactions), so a re-entrant client cannot double-mint.
- `onOrderCancel` returns quietly on an unknown `orderId`. The gateway calls it
  under `try/catch` after protocol state has already finalised, so reverting
  there achieves nothing.

## Known gaps (deliberate — this is a sample)

- **No stranded-USDC recovery.** The Diamond wraps the integrator callback in
  `try/catch`: if `onOrderComplete` reverts, the order still finalises
  protocol-side and the USDC is stranded where `UserProxy.sweepERC20` cannot
  retrieve it. A production integrator needs an explicit recovery path (see
  `MerchantTerminalIntegrator`'s `sweepStrandedBuy`).
- **No offramp / SELL flow.** Buy-side only.
- **No RP-scaled limits**, per above.
- **`circleId` must never reach the Diamond as `0`** — resolve it from the
  subgraph (or let the widget's SDK routing do it). The contract passes through
  whatever it is given; the Diamond rejects `0` with `InvalidCircle`.

## Running it

```bash
npm install
npx hardhat test test/event-ticket-integrator.test.ts
```

25 tests: happy path, per-event cap (reserve / release / per-user / per-event
scoping), per-tx limit, deterministic proxy reuse, completion replay, and
access-control negatives on every gated function.
