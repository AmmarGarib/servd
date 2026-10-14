# connectors/ — the POS connector

servd's only path to FBR/SRB filing, to the card machine, and to Raast QR
bank alerts (bank SMS from a counter phone, 2026-10-12). The vendor
contract is in `docs/pos-connector-api.md` and the design is in the
2026-10-10 spec.

**Never add a direct authority client.** FBR/SRB filing goes only through
the fiscal POS, using this folder's outbox. Every path that completes an
order goes through `completeOrder`, which inserts the sale document.

| File | What |
|---|---|
| `types.ts` | The frozen driver contract: `Outcome`, `ConnectorCtx`, `FiscalDriver`, `TerminalDriver`, payloads and settings |
| `registry.ts` | `FISCAL_DRIVERS` / `TERMINAL_DRIVERS`; `getConnector(tenantId, kind)` (lazy row, 30 s cache, decrypted), `buildCtx`, the injectable clock |
| `config.ts` | Zod settings (defaults and clamps), the SSRF guard, and `fiscalReportingRequired(tenantId)` (§17.7) |
| `util.ts` | `withTimeout`, backoff, HMAC sign and verify, message scrubbing, PKT time helpers |
| `drivers/test.ts` | The built-in deterministic test driver. It never contacts a network and never files a real invoice. |
| `drivers/http.ts` | The generic "servd connector API v1" driver |
| `fiscal/payload.ts` | Builds the payload from STORED order figures, with refunds pro rata, plus the ported SRB and FBR field mappings. A delivery fee stored on the order becomes its own `DELIVERY-CHARGE` line (H9, below). `totalsCheck` enforces the bill identity before anything is sent. |
| `fiscal/outbox.ts` | `enqueueFiscalSaleTx` / `enqueueFiscalRefundTx` (inside the caller's transaction), `sendFiscalDocument` (DB lease, lookup before resubmit), `submitFiscalNow` / `submitFiscalAtTill`, `kickFiscal`, retry, manual filing, release of held documents, the sweeper |
| `fiscal/view.ts` | `FiscalView`, `fiscalViewForOrder`, `legacySrbAlias` |
| `fiscal/qr.ts` | `renderQrSvg` (synchronous inline SVG) |
| `terminal/service.ts` | Card-machine charges: start (re-quote), the forward-only `applyChargeState`, `recordApprovedCharge` (via processPayment / settlePayment / refundOrder), `reverseCharge`, cancel, resolve, refunds, the reconciler |
| `terminal/guard.ts` | `assertNoActiveTerminalChargeTx` (alias `assertNoActiveTenderTx`) and `assertShiftHasNoActiveCharges` — they also refuse while a Raast intent is `awaiting` (409 `RAAST_AWAITING` / `SHIFT_HAS_AWAITING_RAAST`) |
| `raast/reference.ts` | Bank reference normalise / validate / `refInText` (pure) |
| `raast/accounts.ts` | `resolveRaastAccount` (brand override → company default → null; never another company's) |
| `raast/lock.ts` | `lockRaastTx` — the ONE per-company Raast lock, taken FIRST by every Raast write |
| `raast/sms.ts` | The SMS template DSL (never a user regex), `parseSms`, sender normalising, ignore keywords (pure) |
| `raast/devices.ts` | Counter-phone tokens: `sms_<64 hex>`, SHA-256 lookup hash + secretBox ciphertext, format check before any lookup |
| `raast/intake.ts` | Webhook intake (only listed bank senders, never an OTP) and `processAlert` (parse → unparsed / debit / off / match) |
| `raast/match.ts` | `applyBankCredit` (confirm by reference, settle the ONE awaiting intent, else unmatched / ambiguous — never a guess), `matchOnIntentCreated`, `findSmsForRefTx`, `linkAlertTx`, `assertRefNotClaimedTx`, `raiseRaastAttentionTx`, the Raast flags |
| `raast/intents.ts` | The till: config, intents (create / confirm / cancel / expire), bank alerts (list / attach / dismiss / reference fix) |
| `raast/sweeper.ts` | Worker steps: backstop processing, stuck claims, expiry, `raast_unconfirmed` / `raast_sms_unmatched`, SMS text retention |
| `alerts.ts` | ExceptionFlags (connector kinds) plus a best-effort WhatsApp message to the people who can fix the problem |
| `health.ts` | `connectorHealthChecks()` for `/health` (ok / warn / off, never fail) |
| `inbound.ts` | Parses webhook events and applies them to the connector's own company |
| `legacyDrain.ts` | One-off drain of the old `fbr-submission` / `srb-submission` queues. Remove it one release after the cutover. |

Routes are in `modules/connectors/` (`/connectors`, `/connectors/raast/*`,
`/pos/terminal/*`, `/pos/raast/*`, `/pos/orders/:id/fiscal*`,
`/webhooks/pos/:token`, `/webhooks/pos/sms`). The workers are
`workers/fiscalConnector.ts`, `workers/terminalConnector.ts` and
`workers/raastConnector.ts`. The forwarder runbook is
`docs/raast-sms-forwarder.md`.

Rules:

- **One company per row.** Every query carries `tenantId`. Inbound webhooks
  touch only the token's company. A foreign id is ignored or gets a 404.
- **No operator skip.** `skipped` is automatic only: `prefiled_direct`,
  `zero_value`, `zero_value_unsupported` or `no_sale_document`. Held
  documents are released all at once, per company or per brand, and never
  by date range.
- **The payload is frozen** from the first attempt onward. Only a held
  document, or a waiting refund, that has never been attempted is rebuilt
  (a waiting refund from its sale's payload as filed, keeping its own time,
  amount, reason and tender).
- **A live fiscal connector is never re-pointed** from the settings PUT:
  changing its driver or base URL is `409 SWITCH_OFF_FIRST`.
- **BullMQ jobs are removed when they finish.** `attempts` can go down (a
  send that finds the connector off), so a kept job would swallow the next
  kick for the same `fiscal-<id>-<attempts>` slot. The sweeper re-drives any
  due row every 30 s regardless.
- **A card refund is checked before the machine is asked**: RefundPolicy
  reason / photo / the actor's own cap and the card-refundable amount, the
  same refusals refundOrder makes when it books it. There is no manager-PIN
  step on the machine flow. A refund is never reversed.
- **A reversing refund counts only when confirmed** (`vendorMeta.reversal`,
  polled on `<chargeId>-rev…`); a same-day void is final at once.
- **The test driver** produces `TEST-…` numbers with `isTest=true`, and
  receipts say `TEST — NOT A FISCAL INVOICE`.

Delivery charge (2026-10-14, H9) — the fee is a taxed supply:

- An order with `Order.deliveryFeeCents > 0` sends the fee as a **line**
  `{ lineId 'delivery:<orderId>', itemCode 'DELIVERY-CHARGE', description
  'Delivery charge', quantity 1, unit = gross = the fee, taxRatePct = the
  order's standard rate, taxCents = Order.deliveryFeeTaxCents }`
  (`deliveryLineId`, `DELIVERY_CHARGE_ITEM_CODE`). The food lines carry
  `Order.taxCents − deliveryFeeTaxCents`; `saleValueCents`, `discountCents`
  and `taxCents` include the fee line; `totals.deliveryChargeCents` is **0**.
- The discount covers the food lines first, then the delivery line, and only
  the rest is `billDiscountCents` (F-RV-1). A refund spreads its taxable value
  over the sale's lines by taxable value, so it returns its share of the fee
  line.
- A **legacy** delivery order (fee column 0, the fee untaxed inside the bill)
  keeps the old rule: its fee is `totals.deliveryChargeCents`, what is left of
  the bill once food, tax, service and tip are accounted for, and only on a
  delivery order. Any other remainder is a `totals_mismatch`: the outbox never
  files that document (`fiscal_failed`).
- The FBR reference mapping (`toFbrInvoiceFields`) gives the line `ItemCode
  'DELIVERY'` (menu lines stay `POS-ITEM`), `PCTCode 9963.1100`. Contract
  version stays `1` (`docs/pos-connector-api.md`, 2026-10-14).

Raast QR (2026-10-12):

- **The connector row is `kind 'raast'`**, one per company; `enabled` =
  bank-SMS matching ON. Default OFF; only the CEO switches it on, after the
  readiness check (`POST /connectors/raast/sms-on`). No new module id: the
  routes live under `/connectors` (api_pos) and `/pos/raast` (the till).
- **Never a guess.** A bank credit settles an intent only when it is the ONE
  awaiting intent of the same company, bank account and amount (±2 paisa)
  that was still live when the money arrived (`expiresAt > occurredAt`, put
  up no later than `clockSkewMin` after it — however old: RV-FRAUD-2). Two
  candidates → `ambiguous`; none → `unmatched`; a person attaches it at the
  till. The same rule from the intent's side (`matchOnIntentCreated`): another
  live intent that fits the SMS → `ambiguous` (RV-FRAUD-3). An SMS from
  before the intent (older than `clockSkewMin`) is only shown as "possible
  earlier payment" (S1). A till attach refuses a credit from before the bill
  (its waiting request, else the order, minus `matchWindowMin`) → 422
  `RAAST_ALERT_TOO_OLD` (RV-FRAUD-4), and a reference typed at the till that a
  stored credit SMS from before the order or into another account carries →
  409 `RAAST_REF_TOO_OLD`, SMS matching on or off.
- **Short transactions only (M3).** The matcher leases the intent
  (`settlingUntil` + `smsAlertId`) under `lockRaastTx`, commits, calls
  processPayment / settlePayment, then finishes under the lock again. It
  re-reads before any refusal write and writes `needs_attention` only from
  `awaiting` (M2) — a paid receipt is never demoted.
- **Reference claims (M4).** An SMS reference confirms a receipt only on the
  receipt's own bank account, as a credit, in an open status, not older than
  the receipt minus `matchWindowMin`. A dismissed ("not a sale") or debit
  reference is claimed (`BankSmsAlert.claimedRef`) and can never pay a bill.
- **The counter device is the evidence**, never the customer's screen. The
  SMS endpoint keeps only listed bank senders and never stores an OTP / PIN
  SMS. A device token is shown once; a path token only when the device
  allows it (S2). The per-address throttle counts FAILED auths only and never
  refuses a token that resolves to an active device (RV-FRAUD-5 / RV-CO-1: a
  stale phone or another company behind the same NAT cannot lock it out).
- **A future bank API** is one `RaastDriver` in `RAAST_DRIVERS` producing a
  `BankCredit` into `applyBankCredit` — no rework of intents or matching.
- **Void, never booked (2026-10-13/14, CEO only).** A provisional Raast
  receipt on a cancelled or rejected bill whose money no entry ever debited to
  the bank can be voided by the CEO (finance may ask): status `voided`, **no
  ledger entry**, the bank reference stays claimed. A voided receipt is not
  money taken — refund due, hand-back tenders and the Z-report's cancelled-paid
  leave it out (`isVoidedRaast`, `accounting/orderPosting.ts`) — and it stops
  blocking the period close. The code is `modules/reconciliation/raast.ts`; the
  runbook is `docs/raast.md`. Till clearing stays on **1110**.
