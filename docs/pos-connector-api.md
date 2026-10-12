# servd connector API v1

How a fiscal POS (FBR / SRB filing) or a card-payment processor connects to
servd. servd is the order-taking software; it never files with FBR or SRB
itself and never handles card numbers. It sends each completed sale to the
fiscal POS and pushes card charges to the processor's card machine through
this API.

A vendor can implement this contract directly, or put a small adapter in
front of its own API. A vendor whose API is very different gets its own
driver inside servd (`backend/src/connectors/drivers/<vendor>.ts`) instead.

- All amounts are **integer paisa** (PKR × 100). `126500` is PKR 1,265.00.
- All times are ISO-8601. servd sends Pakistan time (`+05:00`).
- The setup screen is in servd admin under **Dev → API → POS connector**.
  It has the base URL, the API key, the webhook secret and the webhook URL.
- Every company (tenant) has its own fiscal connection and its own card
  machine connection. The two can be different vendors.
- **Additions to v1 (backward compatible, 2026-10).** `totals` gained two
  optional fields, `deliveryChargeCents` and `billDiscountCents` (absent =
  0), `totalCents` is documented as the whole bill, and tenders can include
  `wallet`, `gift_card` and the pending cash of a cash-on-delivery order.
  `version` stays `1`: an integration that ignores the new fields keeps
  working, but must not assume the lines plus tax alone add up to
  `totalCents` (see "How servd builds the figures" in §2).

---

## 1. Transport

| Rule | Value |
|---|---|
| Scheme | `https` only. servd refuses `http://`. |
| Host | A host name that resolves to a public address. servd checks every call and refuses private, loopback and link-local addresses. IPv6 address literals are refused (use the host name). |
| Redirects | Not followed. |
| Response size | 256 KB at most. |
| Time limits | Fiscal sale at the till: 0.5–5 s (default 3 s, set per company). Fiscal from the background worker: 15 s. Card machine start: 8 s. Status, cancel and void: 4 s. Health: 5 s. |

### Headers servd sends

```
Authorization: Bearer <apiKey>          (or "<apiKeyHeader>: <apiKey>" when a custom header name is set)
Idempotency-Key: <documentId | chargeId>
X-Servd-Connector: <connectorId>        (opaque; not a company id)
X-Servd-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(webhookSecret, t + "." + rawBody)>
Content-Type: application/json
```

`X-Servd-Signature` is sent only when a webhook secret is set. For a `GET`,
the raw body is the empty string.

### Idempotency

Every request carries an `Idempotency-Key`: the document id for fiscal
calls, and the charge id for card calls. **The vendor must treat a repeated
key as the same request.** Answer with the first result, either with
`200`/`201` or with `409 {"code":"duplicate", …same body…}`. Do not file a
second invoice and do not take a second charge.

servd also looks up a document or charge before sending it again whenever
the earlier answer did not arrive (timeout, dropped connection).

### How servd reads answers

| Answer | Meaning to servd |
|---|---|
| `2xx` | Success |
| `409` with `{"code":"duplicate"}` and the original body | Success (a replay) |
| `400`, `409`, `422` with `{"code","message"}` | Rejected for good. servd shows the code and message to an operator and does not retry automatically. |
| `401`, `403` | Rejected: wrong or expired API key. servd keeps the sales queued and alerts the CEO and IT. |
| `404` on a `GET` | Not found |
| `408`, `429`, `5xx`, connection refused, DNS failure, TLS failure | Temporary. servd retries later and honours `Retry-After`. |
| Timeout or dropped connection after the request was sent | Unknown. servd looks the document or charge up before it sends anything again. |

The vendor must never answer `2xx` for a request it did not act on.

---

## 2. Fiscal POS

### `POST {base}/fiscal/sales` — file a sale

servd sends this once per **full and final bill**: a fully paid or completed
order. Pre-bills, guest checks and open orders are never sent.

Request body (`FiscalPayload`):

```json
{
  "version": 1,
  "documentId": "fdmv3g28l991c0091ddc87cce5",
  "kind": "sale",
  "orderId": "7319ca9e-8298-4097-87f3-104e0621c37f",
  "orderRef": "0621C37F",
  "source": "pos",
  "issuedAt": "2026-10-10T14:30:00+05:00",
  "currency": "PKR",
  "registrations": [{ "authority": "srb", "posId": "123456" }, { "authority": "fbr", "posId": "998877" }],
  "seller": { "legalName": "GS Foods (Pvt) Ltd", "ntn": "1234567-8", "strn": "…", "province": "SD", "address": "…" },
  "buyer": { "legalName": "Acme Traders", "ntn": "7654321-0" },
  "lines": [
    { "lineId": "…", "itemCode": "…", "description": "Beef Nihari (Nalli)", "quantity": 1,
      "unitPriceCents": 180000, "grossCents": 180000, "discountCents": 0,
      "taxableCents": 180000, "taxRatePct": 15, "taxCents": 27000 },
    { "lineId": "…", "itemCode": "…", "description": "Kheer", "quantity": 2,
      "unitPriceCents": 55000, "grossCents": 110000, "discountCents": 0,
      "taxableCents": 110000, "taxRatePct": 15, "taxCents": 16500 }
  ],
  "totals": {
    "saleValueCents": 290000, "discountCents": 0, "taxableCents": 290000,
    "taxCents": 43500, "taxRatePct": 15, "serviceChargeCents": 0, "tipCents": 0,
    "deliveryChargeCents": 0, "totalCents": 333500
  },
  "payment": { "mode": "cash", "tenders": [{ "method": "cash", "amountCents": 333500 }] },
  "servdInvoiceNumber": "STX-2026-0007"
}
```

How servd builds the figures:

- **`totals.totalCents` is the bill** — everything the customer was charged
  for this sale, however they paid it (cash, card, the servd wallet, a gift
  card, or cash still to be collected on delivery). It always satisfies, to
  the cent:

  ```
  Σ lines[].taxableCents + taxCents + serviceChargeCents + tipCents
    + deliveryChargeCents − billDiscountCents  =  totalCents
  ```

  `deliveryChargeCents` and `billDiscountCents` are optional (absent = 0), so
  a payload without them still adds up with the v1 formula. servd checks this
  identity before it sends anything: a document whose figures do not add up
  is never sent (servd holds it as `fiscal_failed`, reason `totals_mismatch`,
  and alerts the company).
- `totals.deliveryChargeCents` (optional) is the delivery fee on a delivery
  order. It is **not taxed**, so it carries no line and no tax. Absent or 0
  on every other order.
- `totals.billDiscountCents` (optional) is the part of a discount that is
  larger than the food — for example loyalty points that also cover the GST
  or the delivery fee, or a 100 % discount that leaves the customer paying
  only the GST. It comes off the bill **after** tax. It is present only when
  it is above 0, and only when every line's `taxableCents` is 0 (the food is
  fully discounted). In that case the stored tax is spread over the lines by
  gross × rate, because GST was levied on the pre-discount value. Treat it as
  discount when you map to an authority (see §5).
- **Tax is what the customer was charged.** servd sends the tax it stored on
  the order. The Pakistan rate depends on the tender: 15 % for cash, 8 % for
  card. The rate is in `totals.taxRatePct`. Line tax adds up exactly to
  `totals.taxCents`. Zero-rated and exempt items carry `taxRatePct: 0` and no
  tax.
- `grossCents` is quantity × (unit price + modifiers). `discountCents` is the
  POS discount plus any storefront promo (and loyalty points), spread over
  the lines and capped at the food value; anything above it is
  `totals.billDiscountCents`. `taxableCents` is gross minus that line's share
  of the discount.
- `payment.tenders` lists how the bill was settled, and the tenders add up
  to `totalCents`. Besides `cash`, `card` and `keenu_qr`, a tender can be:
  - `wallet` — the customer's servd wallet balance (paid online earlier);
  - `gift_card` — a servd gift card (its money was taken when the card was
    sold);
  - `cash` that is still **pending** — the cash a rider collects on a
    cash-on-delivery order, which servd files at completion with the rest
    of the bill;
  - `comp` — a complimentary amount.
  Accept a method you do not recognise; never reject the document for it.
- `payment.mode` is `cash` only when every paid tender is cash. It is `card`
  when every paid tender is a card, Keenu QR or the servd wallet (the wallet
  is paid online, at the card rate), and `mixed` otherwise. A comp and a gift
  card are not money tendered at this sale and do not count toward the mode. A zero-value bill (a full
  comp or a staff meal) has mode `cash` and no tenders. servd sends these
  by default.
- `registrations` lists the authorities and POS ids this sale must be filed
  under. When it holds more than one authority (for example SRB and FBR), file
  with each one and return the extra numbers in `extraNumbers`.
- `buyer` is present only when the customer gave an NTN or CNIC.
- `servdInvoiceNumber` is servd's own internal invoice number, when there is
  one. It is a reference only, never the fiscal number.
- A dry run from the setup screen carries `"test": true` and a `documentId`
  that starts with `test_`. Validate it but do not file it.

Answers:

```
201 / 200   { "status": "filed", "fiscalNumber": "SRB-…", "authority": "srb",
              "qrPayload": "<exact text to print as the QR>", "verifyUrl": "https://…",
              "fiscalAt": "2026-10-10T14:30:02+05:00", "providerRef": "…",
              "extraNumbers": [{ "authority": "fbr", "number": "…", "qrPayload": "…", "verifyUrl": "…" }] }
202         { "status": "processing", "providerRef": "…", "retryAfterMs": 30000 }
```

servd prints `fiscalNumber` with a QR of `qrPayload` (or of `verifyUrl` when
there is no `qrPayload`) on the receipt. While the answer is `processing`,
servd looks the document up after `retryAfterMs`. It does not send it again.

### `POST {base}/fiscal/refunds` — file a refund or void (credit note / sales return)

The body is the same `FiscalPayload` with `"kind": "refund"`, plus these
fields:

- `original`: `{ documentId, fiscalNumber, authority, issuedAt }` of the sale
  being returned.
- `refundAmountCents`: the amount returned, including its share of tax, tip
  and service charge.
- `reason`: the reason the operator gave, when there is one.

The refund is split in proportion to the sale. The tax returned is
`round(sale tax × refund ÷ sale total)`, and tip, service charge, the
delivery charge and any bill discount are split the same way. The remaining
value is spread over the sale's lines. The refund's totals satisfy the same
identity as a sale, with `totalCents` = `refundAmountCents`:

```
Σ lines[].taxableCents + taxCents + serviceChargeCents + tipCents
  + deliveryChargeCents − billDiscountCents  =  refundAmountCents
```

A refund carries `deliveryChargeCents` only when its sale did. servd sends a
refund only after its sale has a fiscal number.

The answers are the same as for a sale.

### `GET {base}/fiscal/documents/{documentId}` — look a document up

| Status | Body |
|---|---|
| `200` | The filed body, as above |
| `202` | `{ "status": "processing", "retryAfterMs": … }` |
| `404` | Never received. servd then sends it. |

### `GET {base}/health`

`200 { "ok": true, "detail": "…" }`

---

## 3. Card machine (payment processor)

servd pushes a charge to a specific card machine. The cardholder taps or
inserts the card on the machine. servd learns the outcome from status polls
or from a webhook. servd never sees a card number; `last4` must be masked
to exactly the last 4 digits.

### `POST {base}/terminal/charges` — start a charge

```json
{ "chargeId": "cm…", "terminalId": "<your device id>", "amountCents": 123800, "currency": "PKR",
  "kind": "charge", "description": "Simmer order 0621C37F",
  "callbackUrl": "https://api.servd.pk/api/v1/webhooks/pos/<token>" }
```

The answer is `200`/`201 { "status": "pending", "providerRef": "…" }`.
`amountCents` already includes any tip.

### `GET {base}/terminal/charges/{chargeId}` — status

```json
{ "status": "pending" | "awaiting_card" | "approved" | "declined" | "cancelled" | "expired",
  "providerRef": "…", "approvalRef": "…", "authCode": "123456", "cardBrand": "VISA",
  "last4": "4242", "amountCents": 123800, "message": "…" }
```

`404` means the charge is not known.

An `approved` answer must include `providerRef`, `approvalRef` and
`amountCents`. If `amountCents` differs from what servd asked for, servd
reverses the charge automatically.

### `POST {base}/terminal/charges/{chargeId}/cancel`

The body is `{}`. The answer has the same shape as the status call. If the
card was already approved, answer `approved`. servd then records the
payment, so the money is not lost.

### `POST {base}/terminal/charges/{chargeId}/void`

The body is `{ "providerRef": "…" }`. The answer is `{ "voided": true }`.
servd voids on the same day (Asia/Karachi). On a later day it uses a
referenced refund instead.

### `POST {base}/terminal/refunds` — refund to the card

```json
{ "chargeId": "<the refund's own id>", "terminalId": "…", "amountCents": 50000, "currency": "PKR",
  "kind": "refund", "original": { "chargeId": "…", "providerRef": "…", "approvalRef": "…" } }
```

The answer is `{ "status": "pending", "providerRef": "…" }`. Poll it like a
charge with `GET /terminal/charges/{refund chargeId}`.

### `GET {base}/terminal/health?terminalId=…`

`{ "online": true }`

### When servd refuses an approved charge

Sometimes the card machine approves a charge that servd cannot accept. For
example, the bill changed, the bill was already paid, or the order was
closed. servd then voids the charge or refunds it automatically. A void is
done when you answer `{ "voided": true }`. A reversing refund (its
`chargeId` is the charge's id plus `-rev`, `-rev1`, …) only counts once
`GET /terminal/charges/{that id}` answers `approved`; while it is pending
servd keeps polling, and if it is declined, expired or unknown servd starts a
new one. If that reversal keeps failing (4 tries over about 40 minutes), or
a reversing refund is never confirmed within 24 hours, servd alerts a
manager.

servd never reverses a **refund**. If a refund is approved for a different
amount than servd asked for, servd books nothing and alerts a manager.

---

## 4. Webhooks (vendor → servd)

```
POST https://api.servd.pk/api/v1/webhooks/pos/{webhookToken}
X-Servd-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(webhookSecret, t + "." + rawBody)>
Content-Type: application/json
```

- Copy the webhook URL and the webhook secret from the setup screen. When
  servd generates a secret, it shows it **once**.
- Sign the exact bytes you send. servd compares signatures in constant time
  and requires `|now − t| ≤ 300 s`.

| Answer | Meaning |
|---|---|
| `200 {"ok":true}` | Applied |
| `200 {"ignored":true}` | Not for this company, or nothing to change. Do not retry. |
| `200 {"ok":true,"duplicate":true}` | This event `id` was already received |
| `401` | Signature missing, invalid or stale |
| `404` | Unknown token. The token may have been rotated. |
| `503` | servd has no webhook secret for this connection. Set one on the setup screen. |
| `429` | More than 120 events a minute on this token |

Bodies:

```json
{ "id": "evt_123", "type": "terminal.charge.updated", "createdAt": "…",
  "data": { "chargeId": "…", "status": "approved", "providerRef": "…", "approvalRef": "…",
            "authCode": "…", "cardBrand": "VISA", "last4": "4242", "amountCents": 123800 } }

{ "id": "evt_124", "type": "fiscal.document.updated", "createdAt": "…",
  "data": { "documentId": "…", "status": "filed" | "processing" | "rejected",
            "fiscalNumber": "…", "authority": "srb", "qrPayload": "…", "verifyUrl": "…",
            "fiscalAt": "…", "code": "…", "message": "…" } }
```

The event `id` must be unique per event; servd ignores a repeated `id`. A
state only moves forward. For example, a `declined` that arrives after
`approved` changes nothing. Webhooks are optional, because servd also
polls. They make the till faster.

---

## 5. Reference: SRB and FBR invoice fields

servd's old direct filers sent the following figures. A fiscal POS that
files with the authorities can derive them from the payload. The code is
in `backend/src/connectors/fiscal/payload.ts` (`toSrbInvoiceFields`,
`toFbrInvoiceFields`).

| SRB field | From the payload |
|---|---|
| `rateValue` | `totals.taxRatePct` (15 or 8) |
| `saleValue` | `totals.saleValueCents ÷ 100`. This is gross, **before** discount, without tax. |
| `taxAmount` | `saleValue × rateValue ÷ 100`. This is SRB's formula, on the pre-discount value. |
| `discountAmount` | `(totals.discountCents + totals.billDiscountCents) ÷ 100` (a missing `billDiscountCents` is 0) |
| `netAmount` | `saleValue + taxAmount − discountAmount` |
| `modeOfPay` | `Cash` when every tender is cash, otherwise `Card` |
| `invoiceType` | 1 for a sale, 2 for a sales return |
| `invoiceDateTime` | `issuedAt` written as `yyyy-MM-dd HH:mm:ss` in Pakistan time |

| FBR (PRAL) field | From the payload |
|---|---|
| `TotalBillAmount` | `totals.totalCents ÷ 100` |
| `TotalSaleValue` | `(totals.totalCents − totals.taxCents) ÷ 100`, never below 0. It includes the delivery charge, service charge and tip. |
| `TotalTaxCharged` | `totals.taxCents ÷ 100` |
| `Discount` | `(totals.discountCents + totals.billDiscountCents) ÷ 100` (a missing `billDiscountCents` is 0) |
| `PaymentMode` | 2 when any tender is cash, 3 for Keenu QR, otherwise 1 (card — the servd wallet and a gift card included) |
| `InvoiceType` | 1 for a sale, 3 for a credit note (`RefUSIN` = the original fiscal number) |
| `Items[].PCTCode` | `9963.1100` (restaurant food service) |
| `Items[].TaxCharged` | `lines[].taxCents ÷ 100` |

---

## 6. Going live (CEO)

1. Pick the driver. Enter the base URL and the API key. Generate a webhook
   secret and give it, with the webhook URL, to the vendor.
2. Click **Test connection**, then **Dry-run sale**.
3. Enter the POS id of every brand, and of every outlet that registered
   separately.
4. Click **Go live**. Sales completed after this point are filed.
5. Click **Release all held** to file every sale completed before go-live.
   Late filing is never silent, and no sale is ever skipped.

While the fiscal POS is live, its driver and base URL cannot be changed
(`409 SWITCH_OFF_FIRST`). To move to another vendor, the CEO switches it off,
IT changes the settings and tests again, and the CEO goes live again. The
API key can be rotated while live.

A company that does not need fiscal reporting can have it turned off by the
CEO. Examples are a test company or a home kitchen. Its sales are then never
sent, and its receipts say "Not a tax invoice".
