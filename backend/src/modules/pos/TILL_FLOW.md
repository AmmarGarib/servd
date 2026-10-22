# Till flow — backend contract (owner, 2026-10-20)

The screens agent builds the new till against THIS file. Every route is under
`/api/v1`. `/pos/*` and `/floors/*` are never module-gated; `/accounting/*` is
under the `accounting` module gate. All money is integer paisa (`…Cents`).
Errors are `{ error: { code, message, details? } }` with the HTTP status shown.
Roles: `CASHIERS` = managers (admin, owner, manager, management,
foh_management, boh_management, fnb_manager) + cashier, foh, finance.
`ALL_STAFF` = every staff role except director.

Company separation (binding): a brand / order / shift / table of another
company is **404**; a waiter, customer, delivery zone or table that is not the
brand's company's is **422**. New tickets bind to the ACTIVE company
(`POST /pos/orders` 422 `NO_ACTIVE_COMPANY` without one).

---

## 1. Start menu (screens only)

ORDERING: Dine In, Delivery, No Charge, Order Summary · MANAGER · OTHER
(Takeaway). The server accepts `fulfilmentType` `dine_in` | `takeout` |
`delivery` on `POST /pos/orders`. "No Charge" is the EXISTING comp
(`POST /pos/orders/:id/comp`, unchanged).

### Order Summary — `GET /pos/shifts/current/summary` — CASHIERS
The CALLER's own open drawer only (never another cashier's; blind count — no
expected cash / variance). `{ shift: null }` when the caller has no open drawer.
```jsonc
{ "shift": {
  "shiftId", "openedAt", "ordersCount", "grossCents", "salesExTipsCents", "taxCents", "tipsCents",
  "serviceChargeCents", "discountCents", "compCents", "refundsCents",
  "byTender": { "cashCents", "cardCents", "raastCents", "onAccountCents", "walletCents", "giftCardCents" },
  "bySettlement": { "keenu": { "orders", "amountCents" }, "servd": { … }, "none": { … } },  // money taken on this drawer
  "openTickets": { … }  // as the Z-report's
} }
```
(The full Z-report stays `GET /pos/shifts/:id/zreport` — managers + finance.)

### Order Summary list — `GET /pos/orders/summary?conceptId&date&tab&type&q[&format=pdf|xlsx|csv]` — CASHIERS
(owner, 2026-10-22; `pos/orderSummary.ts`). One brand, one Karachi calendar day. `tab` all | running |
settled | voided (running = received…ready, settled = completed, voided = cancelled | rejected | refunded);
`type` all | dine_in | takeout | delivery | no_charge (a paid comp covering the bill). →
`{ date, counts: { all, running, settled, voided }, rows: [{ id, orderNo, placedAt, time, receiptNo,
table, type, guest, user, waiter, status, orderStatus, amountCents, compCents }] }`; another company's
brand 404. Read only: the screen's Recall / Reprint Receipt / Reprint KOT / Void (running: cancel;
settled: `POST /invoices/orders/:id/credit-note`) / Split / Change Owner call the existing routes.

## 2. Dine In — the table board

### `GET /floors/board?conceptId=<uuid>&floorId=<uuid?>` — ALL_STAFF
Brand of another company → 404.
```jsonc
{
  "conceptId": "…",
  "totals": { "tables": 24, "occupied": 7, "vacant": 17 },
  "floors": [
    { "id": "…" /* null = tables with no floor */, "name": "Main", "displayOrder": 0,
      "totals": { "tables": 12, "occupied": 3, "vacant": 9 } }
  ],
  // tables of `floorId` when given, else every table of the brand
  "tables": [
    { "id": "…", "label": "T4", "capacity": 4, "floorId": "…", "shape": "rectangle",
      "x": 40, "y": 40, "width": 120, "height": 80, "rotation": 0,
      "status": "ordered",          // Table.status as stored
      "occupied": true,             // an OPEN order (received|confirmed|preparing|ready) sits on it
      "order": {                    // the oldest open order on the table, null when vacant
        "id": "…", "ref": "AB12CD34", "status": "preparing", "totalCents": 126500,
        "placedAt": "…", "partySize": 3, "customerName": "Ali",
        "waiter": { "id": "…", "code": "GSF-0007", "name": "Bilal" } /* or null */
      },
      "openOrders": 1,
      "openOrderIds": ["…"]          // every open ticket on the table, oldest first
    }
  ]
}
```
Occupancy is computed from open orders (the truth); `Table.status /
currentOrderId / currentPartySize` are written when a ticket opens and cleared
when it completes or is cancelled.

### Waiter assignment on an occupied table
`PATCH /pos/orders/:orderId/info` with `waiterEmployeeId` or `waiterCode` (§3).

## 3. Order information (choosing a table)

### `GET /pos/waiters?conceptId=<uuid>&q=<text?>&locationId=<uuid?>` — CASHIERS
`{ "waiters": [{ "id", "code", "name" }] }` — HR employees (login or not) of
the brand's company, status active / on_leave, by name. `q` matches the name
(contains) or the code (prefix). **Waiter code = `HrEmployee.employeeCode`**
(e.g. `GSF-0007`, unique per company).

### `GET /pos/guests?conceptId=<uuid>&q=<text>` — CASHIERS
`{ "guests": [{ "id", "name", "phone" /* mobile */, "altPhone" /* phone */, "email" }] }`
— ONLY customers of the brand's company (an order or a booking at its
brands). `q` ≥ 2 chars; matches name / email (contains) or mobile / phone
(digits, contains; a leading 0 also tried as 92…). Max 20.

### Open the ticket — `POST /pos/orders` — CASHIERS (extended)
Existing body (conceptId, tableId, items[], discountCents, discountReason,
managerOverridePin, idempotencyKey, paymentMethod, shiftId, customerId) PLUS:
```jsonc
{
  "fulfilmentType": "dine_in" | "takeout" | "delivery",  // default: dine_in with a table, else takeout
  "waiterEmployeeId": "uuid",          // OR
  "waiterCode": "GSF-0007",            // (not both → 400 WAITER_ONE_OF)
  "partySize": 3,                      // pax 1..500
  "customerId": "uuid",                // a guest from /pos/guests, OR
  "guest": { "name": "Ali", "email": "a@x.pk", "mobile": "0300…", "phone": "021…", "registrationNo": "R-12" },
  "delivery": { "name", "phone", "address", "notes"?, "zoneId"?, "cod": true|false }  // §7
}
```
The "Order information" panel is held by the screen until the first **Save**,
which sends it with the first round's items (the ticket is created and fired
then). It can be changed later with `PATCH /pos/orders/:orderId/info`.
Response 201: the order as before (with `items`, `payments`) plus the new
columns `settlementChannel`, `waiterEmployeeId`, `partySize`,
`guestRegistrationNo`.
Errors: 422 `TABLE_NOT_IN_BRAND`, `ITEM_NOT_IN_BRAND`, `WAITER_NOT_IN_COMPANY`,
`WAITER_CODE_UNKNOWN`, `CUSTOMER_NOT_FOUND` (another company's customer reads
the same as an unknown one), `DELIVERY_ZONE_REQUIRED`, `DELIVERY_ZONE_NOT_FOUND`,
`BELOW_ZONE_MINIMUM`, `NO_ACTIVE_COMPANY`; 400 `GUEST_ONE_OF`,
`WAITER_ONE_OF`, `DELIVERY_DETAILS_REQUIRED`, `DELIVERY_HAS_NO_TABLE`,
`DELIVERY_NEEDS_FULFILMENT`, `GUEST_NAME_REQUIRED`, `INVALID_PHONE`;
403 `DISCOUNT_OVER_CAP` etc. as before.

A new guest is matched by mobile, then email, among the company's customers
(or a servd account no company has dealt with); a match only gains missing
fields. A mobile / email belonging only to another company's customer is NOT
linked — the guest stays on the order by name.

### `GET /pos/orders/:orderId/info` — CASHIERS
### `PATCH /pos/orders/:orderId/info` — CASHIERS
Body (all optional): `waiterEmployeeId` (uuid, or `null` to clear) | `waiterCode`,
`partySize` (or null), `customerId` (or null) | `guest` {…as above},
`tableId` (move the ticket to a vacant table of the same brand),
`delivery: { cod: boolean }` — a till delivery only: switch cash on delivery ⇄
pay now while nothing is paid and the rider has not picked it up. `cod: true`
adds ONE pending cash payment for the bill and closes it in servd; `cod: false`
marks the pending COD cash row `failed` (gatewayMeta.voided) — pay it at the
counter (servd or Keenu). 400 `NOT_A_TILL_DELIVERY`, 409 `ALREADY_PAID`,
`ALREADY_PICKED_UP`, `SETTLED_AT_KEENU`.
Response (both):
```jsonc
{ "orderId", "orderRef", "status", "fulfilmentType", "settlementChannel",
  "table": { "id", "label", "floorId" } | null, "partySize",
  "waiter": { "id", "code", "name" } | null,
  "guest": { "id"|null, "name", "mobile", "phone", "email", "registrationNo" } | null,
  "totalCents",
  "delivery": { "cod", "name", "phone", "address", "notes", "zoneId", "zoneName", "feeCents" } | null  // till deliveries
}
```
`GET /orders` (the order lists the till reads) now also returns on every row:
`settlementChannel`, `partySize`, `waiterEmployeeId`, `waiter { id, employeeCode, fullName } | null`,
`guestRegistrationNo`, and `cod` (true for a till delivery collected on delivery).
Errors: 404 foreign order; 409 `ORDER_ENDED` (not open), `TABLE_OCCUPIED`;
422 as in POST; 400 `GUEST_ONE_OF`, `DELIVERY_HAS_NO_TABLE`.

## 4. Order screen

- Menu: existing `GET /menu/:conceptId` (categories → items, modifiers).
- **Item search** `GET /pos/menu/search?conceptId&q&categoryId?` — CASHIERS →
  `{ "items": [{ "id", "name", "itemCode", "priceCents", "isAvailable", "categoryId", "categoryName" }] }`;
  `q` matches name (contains) or item code / SKU (prefix); an exact code first. Max 50.
  Item codes are set on the menu item (`itemCode` on `POST/PATCH /menu/items`,
  unique per brand → 409 `ITEM_CODE_TAKEN`).
- Cart totals: `POST /pos/quote` (unchanged + `fulfilmentType`, `zoneId` for a
  delivery) → `itemTotalCents, discountCents, itemTaxCents, deliveryFeeCents,
  deliveryFeeTaxCents, taxCents, serviceChargeCents, totalCents, taxRatePct`
  (the server's figures; tax per tender: cash 15% / card+Raast 8%).
  For a saved ticket: `GET /pos/orders/:orderId/quote?method=cash|card|raast`.
- **Save** (keep open + send to kitchen): `POST /pos/orders` creates the ticket
  and fires it (existing KDS routing). A LATER ROUND on the same table is
  another `POST /pos/orders` with the same `tableId` (+ waiter / pax) — a
  second ticket on the table, as the till works today (the board lists every
  open ticket in `openOrderIds`; settle each, or split). Appending lines to an
  existing ticket is NOT in this release (stock depletion is per ticket).
- **Discount**: on the ring-up (`discountCents`, `discountReason`, manager PIN above cap) — unchanged.
- **No Charge**: `POST /pos/orders/:id/comp` — THE comp engine (reason, manager PIN above the comp limit). Unchanged.
- **Cancel / void**: existing manager-only routes. Unchanged.
- **Print**: pre-bill `POST /pos/orders/:id/pre-bill` (never fiscal). Unchanged.

## 6. Settle — two ways to close a bill

### a. Close in servd (cash / card / Raast QR / on account)
Revenue → the brand's **servd sub-account** "Sales — <brand> (servd)".
The sale's fiscal document is created at completion with status
`manual_required`, `statusReason: "servd_channel"` — **never sent** to the
fiscal POS; finance records the portal filing (§8).

- `POST /pos/payments` (existing body) + `"settlementChannel": "servd"`.
  **Split tender is supported**: several tenders in ONE call
  (`payments: [{cash…}, {card…}, {raast…}]`) whose amounts (less their tips)
  cover what is due — e.g. half cash, half card. A part payment alone is
  refused (400 `AMOUNT_MISMATCH`); to settle a bill in separate sittings,
  split it first (existing `/check-split`) and settle each portion
  (`POST /pos/payments/:id/settle` after `PUT …/settlement-channel`).
  Each tender may carry `"excessAsTip": true` (cash only): cash handed over
  above `amountCents` (`tenderedCents − amountCents`) is kept as a TIP (added
  to `amountCents` and `tipCents`; change = 0) — i.e. tip = tendered − due
  (tested; the tip pool sums `Order.tipCents`, so it picks it up). Card / Raast tips: send
  `tipCents` (part of `amountCents`) as today. Tips → `Order.tipCents` → 2095
  Tips Payable → the tip pool; never revenue.
  400 `TIP_FROM_EXCESS_CASH_ONLY`.
- Card machine, Raast request, split, on-account and every other tender path:
  first `PUT /pos/orders/:orderId/settlement-channel {"channel":"servd"}`
  (CASHIERS) → `{ orderId, settlementChannel: "servd" }`. 409 `ORDER_ENDED`,
  `SETTLED_AT_KEENU`, `CHANNEL_LOCKED` (money already taken under another channel).
- Responses unchanged (`payments`, `orderCompleted`, `fiscal`, `srb`, `raast`);
  `fiscal.rawStatus` = `manual_required`, `fiscal.statusReason` = `servd_channel`
  → show "Filed by hand (servd)".

### b. Push to Keenu
Revenue → the brand's **main** sales account. Keenu settles the bill and files
it; servd records Keenu's tender and completes the order; the sale's fiscal
document is sent (exactly once) carrying `settlement.pushId`.

- `POST /pos/orders/:orderId/keenu-push` — CASHIERS
  Body `{ "shiftId": uuid, "method": "cash"|"card", "tipCents"?: int }`
  (the bill is re-priced for `method`).
  - **201** `{ "state": "settled", "pushId", "providerRef", "approvalRef", "payments", "orderCompleted", "fiscal", "srb", "replayed" }`
  - **202** `{ "state": "pending", "pushId" }` → poll `POST …/keenu-push/check`
  - 409 `KEENU_NOT_AVAILABLE` (no live fiscal POS), `KEENU_PUSH_UNSUPPORTED`,
    `KEENU_REPORTING_OFF` (company does not report — close in servd),
    `KEENU_WHOLE_BILL` (money taken / pending, wallet or promo on the bill),
    `ORDER_NOT_OPEN`, `NOTHING_DUE`, `KEENU_AMOUNT_MISMATCH`, `KEENU_PUSH_STALE`;
    422 `KEENU_DECLINED`; 503 `KEENU_UNAVAILABLE`; 422/403 shift errors
    (`SHIFT_NOT_IN_COMPANY`…, `NOT_YOUR_SHIFT`).
- `GET /pos/orders/:orderId/keenu-push` → `{ settlementChannel, push: { pushId, state, method, amountCents, tipCents, at, approvalRef, reason } | null }`
  (`state`: pending | settled | declined | failed | needs_attention).
- `POST /pos/orders/:orderId/keenu-push/check` → same shapes as the push (200 settled / 202 otherwise).
- While a push is pending every other tender, comp, cancel, split … answers
  409 `KEENU_PUSH_PENDING`; after it settled, `/pos/payments` answers 409 `SETTLED_AT_KEENU`.
- Test driver (until Keenu's API): settles at once; `settings.test.push` =
  `settle` | `decline` | `pending` on the fiscal connector.

### Quick Pay
= Close in servd with one cash tender for the whole bill (`POST /pos/payments`
with `settlementChannel: "servd"`).

### Refunds / credit notes
Existing routes; they reverse the account the SALE credited (servd sub-account
or main). A servd-channel return's fiscal document is also `manual_required` /
`servd_channel`.

## 7. Delivery from the till

`POST /pos/orders` with `fulfilmentType: "delivery"` and
`delivery: { name, phone, address, notes?, zoneId?, cod }`.
- Zones: `GET /pos/delivery-zones?conceptId` → `{ zones: [{ id, name, feeCents, freeAboveCents, minOrderCents, estimatedMinutes, conceptId }] }`.
  A zone is required when the brand has zones. Fee before GST from the zone;
  GST on top at the tender's rate (H9). Quote with `POST /pos/quote` +
  `fulfilmentType: "delivery", zoneId`.
- The order is stored as source `manual` + `rawPayload.channel "till_delivery"`:
  it goes to Dispatch (existing board / rider app, hand-over code as today) and
  **completes on delivery**, never at payment.
- `cod: false` → pay at the counter now: `POST /pos/payments` (with
  `settlementChannel: "servd"`) or Push to Keenu. `orderCompleted` is false
  until the rider delivers.
- `cod: true` → a PENDING cash payment the rider collects; the bill is closed
  in servd automatically (`settlementChannel: "servd"`). After delivery it is
  COD custody (lib/cod.ts); the rider pays it in through the existing
  `GET /pos/cod-due` + `POST /pos/payments/:id/settle`.
- Code-only delivery switch rules apply as today.

## 8. Finance — servd sales to file by hand

- `GET /accounting/servd-filings?status=unfiled|filed|all&dateFrom&dateTo&conceptId&limit`
  (FINANCIALS_VIEWERS) → `{ documents: [{ id, kind, orderId, orderRef, conceptId, brandName, amountCents (refunds negative), saleDay, status: "unfiled"|"filed", rawStatus, portalReference, authority, filedOn }], unfiled: { count, amountCents } }`.
- `POST /accounting/servd-filings/record` (admin, finance) body
  `{ documentIds: string[1..500], portalReference, authority: "srb"|"fbr", filedOn: "YYYY-MM-DD", note? }`
  → `{ recorded, documentIds }`. All or nothing: 404 any foreign / unknown /
  non-servd id; 409 `NOT_MANUALLY_FILABLE`; 422 `FILED_IN_FUTURE`.
- Month close: check **`servd_sales_unfiled`** (block, CEO-overridable with
  `acknowledge`) while any servd-channel document dated on or before the lock is unfiled.

## 9. Reports

`GET /reports/sales`, `/reports/by-source`, `/reports/by-tender`,
`/reports/top-items` take `settlement=keenu|servd|all` (default all; `none` =
legacy / non-till only). Exports (`?format=csv|xlsx|pdf`) carry it in the title.
`GET /reports/by-settlement` → `{ rows: [{ settlement: "keenu"|"servd"|"none", ...SalesTotals }], combined: SalesTotals }` (combined = the sum).
