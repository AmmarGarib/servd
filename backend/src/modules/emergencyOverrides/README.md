# Emergency overrides — `/emergency-overrides`

Operations → Emergency overrides. This module is for a delivery that has gone wrong at the door, once a company runs **code-only delivery**. Under code-only delivery a delivery completes only with the customer's 4-digit code. The staff "Delivered" override is gone.

This module is a thin shell. The rules live where they already were:

| Action | The one implementation |
|---|---|
| Code-only switch | `lib/deliveryRules.ts` `codeOnlyDelivery` / `setCodeOnlyDelivery` |
| Send the code to the rider | `dispatch/service.ts` `rerouteHandoverCode` |
| Resend it | `dispatch/service.ts` `resendReroutedCode` |
| Food came back | `orders/returnedFood.ts` `returnUndeliveredOrder` |

`service.ts` holds the lists, the preview, the scope resolution and the switch read. `routes.ts` is the default export `emergencyOverridesRoutes`, which the API registers at `/emergency-overrides`.

## Access

- **Module:** `emergency_overrides`. `GATED_PREFIXES` in `lib/moduleAccess.ts` gates the whole prefix on it.
- **Default holders:** RGM (`foh_management`), chef (`boh_management`), `fnb_manager`, `management` and the CEO (`admin`).
- **Not by default:** cashiers, the co-owner (`owner`) and the legacy `manager`.
- The routes admit `MANAGERS`, and the module decides who gets through. The CEO can untick the module per role in Module Access, and the untick holds (`MODULE_GRANTS` adds it to saved rows once only).
- `PUT /settings` is `ADMIN_ONLY` (the CEO).

## Company separation

- **Reads:** every read goes through `serviceClient` with explicit company filters on the **order's** company (`concept.tenantId`). A fleet partner's rider row belongs to another company, and RLS would hide it.
- **What a fleet partner sees:** the provider company never sees its client's orders, and that includes the recent-overrides list. Only the client sees them. The client sees the provider's **name** and nothing more.
- **Actions:** every action resolves the order through the caller's **write** scope (`scopeTenantWhere(req, 'write')`) on its brand, before anything else runs. A foreign or unknown id is 404.
- **Reads (`/orders`, `/settings`, `/return-preview`):** these use the **read** scope.
- **The actor:** each action runs as the caller, with `actor.tenantId` set to the **order's** company. Event, audit, exception and waste all land in that company.

## Contract

Errors use the API's normal shape: `{ error: { code, message } }`.

### `GET /settings`

Returns `{ companies: [{ tenantId, name, codeOnly, since }] }` for the companies in the caller's read scope. `since` is the ISO time the switch was turned on, or `null`.

### `PUT /settings` — CEO only

Body: `{ tenantId, codeOnly: boolean, reason: 10..500 chars }`.

- `tenantId` must be a company the CEO is a **member** of. Any other company is 404.
- Calls `setCodeOnlyDelivery`, which audits `delivery.code_only.switch` in that company with the reason.
- Returns `{ company }`.

Every **action** below (the three POSTs) answers **409 `CODE_ONLY_OFF`** while the order's company has the switch off. The reads always work: each list row carries `codeOnly`, so the page can grey out the buttons.

### `GET /orders` → `{ onTheRoad, recent }`

`onTheRoad` holds every in-scope delivery order with all of these: status `ready`, a rider, not delivered, not returned. Each row:

```
{ orderId, ref, brand, customerName,
  stage: 'assigned'|'accepted'|'picked_up'|'arrived',   // no-app rider → 'picked_up'
  rider: { id, name, fleetPartner: <provider company name> | null },
  cashToCollectCents,        // pending cash-on-delivery rows
  codeLocked,                // deliveryOtpAttempts ≥ DELIVERY_OTP_MAX_ATTEMPTS
  rerouted: { at, byName } | null,
  doorProblem: { kind: 'no_code'|'refused'|'unreachable', at } | null,  // the current rider's latest
  minutesOut,                // since pickup (else accept / assign / placed)
  codeOnly }
```

`recent` holds the `code_rerouted` and `returned` job events of the last 14 days on in-scope orders, as `{ id, type, at, orderId, ref, brand, riderName, actorName, note }`.

The customer's code is never in either list.

### `POST /orders/:id/send-code-to-rider`

Body: `{ reason: 10..300 }`. Calls `rerouteHandoverCode`, which:

1. mints a **new** code, so the customer's old one stops working;
2. resets the wrong-code count, keeping the old count for rider scoring;
3. pins the order to this rider;
4. sends the code by WhatsApp to the rider's own number.

It works **once per order**. A second call is 409 `ALREADY_REROUTED`. Returns `{ ok, sentToRider, riderPhoneHint }`.

Error codes pass through unchanged: `NOT_A_DELIVERY`, `ALREADY_DELIVERED`, `NOT_READY`, `NO_RIDER`, `NOT_PICKED_UP`, `ALREADY_REROUTED`, `RIDER_HAS_NO_PHONE`, `ORDER_CHANGED`.

### `POST /orders/:id/send-code-to-rider/resend`

Sends the **same** code to the **same** rider. Rate limit: **3 per 10 minutes per order**, keyed on the order id, then 429. The limit runs after the scope and switch checks, so a foreign or refused call never spends the order's budget. Returns `{ ok, sentToRider }`. Error codes: `NOT_REROUTED`, `ALREADY_DELIVERED`, `RIDER_HAS_NO_PHONE`.

### `POST /orders/:id/food-returned`

Body: `{ cause: 'refused'|'unreachable'|'other', reason: 5..500, managerOverridePin? }`. Calls `returnUndeliveredOrder`. Returns:

```
{ ok, wasteCostCents, wasteLogIds, codVoidedCents, refundDueCents, strike: { recorded, duplicate } | null }
```

- A replay is 409 `ALREADY_RETURNED`.
- A till (`pos`) order needs a manager. Every default holder of this module already is one. `managerOverridePin` covers a role the CEO added later.

### `GET /orders/:id/return-preview`

Returns `{ lines: [{ name, quantity }], codToVoidCents, paidCents }` for the "Food came back" dialog. `lines` are the live (unvoided) lines, which will all be wasted.

## What each action books

- **Send the code / resend:** books **nothing**.
  - Writes a `code_rerouted` job event naming the manager.
  - Writes an audit row `delivery.code_rerouted` (or `delivery.code_resent`).
  - Raises a **high** `delivery_code_rerouted` exception in the order's company so someone checks that the customer got the food and the cash was collected.
  - The order still closes through the rider app with a verified code.
- **Food came back:**
  - **The order:** cancelled through the one cancel path, with `returnedAt` and `returnCause` stamped. No fiscal document is filed, because there was never a sale.
  - **The food:** every live line is wasted as `returned_food`: Dr **1290** Stock Differences Suspense / Cr 1210 | 1220 | 1230, in the order's company. The CEO later approves it into **5040** on Finance → Stock differences (H20).
  - **Cash on delivery:** the pending COD row becomes `failed`, with `gatewayMeta.voided`. Nothing is posted, because the money never arrived.
  - **Money already paid:** card, Raast or a paid ticket goes back through the existing cancelled-ticket hand-back. `refundDueCents` shows it; this route never moves it.
  - **Records:** a `returned` job event and a `food_returned` exception carrying the waste cost.
  - **Strike:** recorded **only** for `refused`, and only when the order has a customer (one per order).
  - **Closed period:** if the posting is refused because the period is closed, the cancel still stands. The posting is flagged `posting_failed` and re-posted from Reconciliation → Backfill unposted.

## The switch

Code-only delivery is per company and **OFF by default**, which is today's behaviour: staff "Delivered" works and these actions are 409. While a company has it off, nothing on this page changes anything for that company.

The CEO turns it on per company in `PUT /settings`, giving a reason; the change is audited. Switching it on takes away staff "Delivered" across `/dispatch`, `/expo` and the tablet (404). The rider's door-problem button then appears too.

## Open owner questions (defaults built)

- **Q1 — who uses this page:** the five roles above, never the co-owner, the legacy manager or cashiers. The CEO can change this in Module Access.
- **Q2 — a new code on reroute:** sending the code to the rider generates a **new** code, once per order, and pins the order to that rider.
- **Q3 — who sees the code:** no one reads a customer's code in the admin, the CEO included. The rerouted code goes only to that rider.
- **Q4 — no answer:** "could not reach the customer" earns **no** strike. Only `refused` does, always with weight 1.
- **Q5 — prepaid comes back:** a prepaid delivery that comes back is accepted. The food is wasted and the money goes back through the cancelled-ticket hand-back.
- **Strikes across companies:** the owner decided on 2026-10-15 that strikes and bans are **servd-wide** (one customer account across every company). `returnUndeliveredOrder` still stamps the strike with the order's company for the record; counting and banning are `lib/strikes.ts`'s job.
- **Resend limit:** 3 per 10 minutes per order (a constant in `routes.ts`).
