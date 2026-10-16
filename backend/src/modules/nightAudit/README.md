# Night audit — SALES module only (owner, 2026-10-16)

> "Night run/Audit/Day close is only for sales module, it does not apply on all
> other modules." — Ammar (CEO), 2026-10-16. This overrides any broader reading.

## Scope (read first)

**In scope** — the night checks, the day lock and the CEO back-dating rule:
orders / tickets (customer bills), their payments and tenders (cash, card,
Raast, gift card or wallet *as a tender*, the on-account charge, COD), item
voids, comps, cancels / rejects, refunds, a sale's tax-invoice credit note,
till shifts and drawer cash, deposit drops of till cash, and the ledger
postings those create (`lock.ts` `SALES_SOURCES` / `SALES_SOURCE_PREFIXES` /
`isSalesSource` — THE definition, pinned by a test).

**Out of scope** — keep their existing rules, never checked or locked here:
purchases / GRNs / supplier bills and payments, petty cash (incl.
`pettycash.till_topup`) and cash vouchers, OpEx, CapEx, fixed assets and
depreciation, prepaid releases, payroll / HR / tip-pool payouts, manual
journals and journal requests, receivables, inter-company (`ic.*`) and
head-office recharges, tax payments, gift-card sale / void / breakage, wallet
top-ups, loyalty expiry, reservation deposits (Q6), stock counts / waste /
transfers, and bank-dated reconciliation entries (`card.settlement`,
`reconciliation.adjustment`).

**The month-end period lock is unchanged, for everything.**

## Lifecycle (one `NightAuditDay` per company per Karachi date; no row = open)

```
open ──run (finance / CEO)──▶ audited ("awaiting settlement")
     ──settle (auto / manual / CEO override)──▶ closed
audited | closed ──reopen (CEO only, reason ≥ 10)──▶ open
```
`audited` and `closed` days are LOCKED for sales postings: `postJournalEntry`
answers 422 `DAY_AUDITED { day, status }` to a sales source dated into one.
Everything else posts as before. Sales, voids, comps, refunds and cancels post
"now", so a change today to an older bill lands today. Backfills
(`reconciliation/backfillOrders.ts`, `accounting/shiftPosting.ts`
backfill), a retried refund (`orderPosting.ts postRefundPayment`, through
`lock.ts salesPostingDate`) and `lateDatingFor(…, sourceType)` move a sales
posting out of a locked day to today with the note "dated <day>, posted late
(the night audit locked that sales day)".

## Checks (`checks.ts`; every block CEO-overridable with a reason)

Night (open → audited): `open_tills`, `cash_variance_open` (Q4),
`open_orders`, `unposted_shifts`, `unposted_orders`, `posting_failed` (SALES
sources only), `raast_open_night` (Q1), `cod_pending`, `tenders_unresolved`
(a card-machine charge with no final outcome blocks, `needs_attention`
included; an `unverified` / `manual_resolved` charge alone is a warn).

Settlement (audited → closed): `card_unsettled_day` (or `card_matching_off`),
`raast_unmatched_day`, `cash_not_banked` (Q2 — AMOUNTS per till: Σ every
deposit drop's share for the till vs its cash to bank (drops + counted close −
float kept); nothing banked blocks, a part banked blocks beyond the cash
tolerance; one bag may be split across several tills, `deposit_drop_shifts`
read through `depositPosting.ts dropAllocations`), `sales_bank_unmatched` (bank
lines of sales sources dated that day + the deposit drops with a share of that
day's tills, whenever dropped). A throwing check is `check_failed:<key>`.
`cod_pending` links to Reconciliation → Cash on delivery only while the
company's code-only delivery switch is on; otherwise to the till's pay-in list
(`reconciliation/codCloseCheck.ts codPendingLink`).

Tills belong to their BUSINESS day (`lib/businessDay.ts`, owner 2026-10-16):
a till closing before 05:00 PKT is on the day it opened — its close posting
is dated 23:59:59.999 PKT of that day, and the shift checks, the daily report
and the activity days place it there.

Active day (`activity.ts`): orders placed / completed / scheduled, tills
opened / closed (a close on its business day), payments created — nothing else.

## Run rules (in order)

422 `INVALID_DATE` → 422 `DAY_NOT_OVER` → 409 `DAY_IN_CLOSED_PERIOD` →
409 `ALREADY_AUDITED` → 409 `EARLIER_DAYS_OPEN { days }` (active days from the
start day not audited; the first run sets `Tenant.nightAuditStartDay`, Q3) →
403 `OVERRIDE_CEO_ONLY` / 422 `OVERRIDE_REASON_REQUIRED` / 422
`NOT_OVERRIDABLE` → 409 `NIGHT_AUDIT_NOT_READY { problems, blocks, missing? }`.
One transaction under `pg_advisory_xact_lock(hashtext('night-audit:'||tenantId))`.
After: audit `night_audit.run | night_audit.override`, flag
`night_audit_override` (high) on an override, then an automatic settle.

Settle: 409 `NOT_AUDITED`, 409 `SETTLEMENT_NOT_READY`; the CEO's acknowledge
closes with `closedVia 'override'` (audit `night_audit.settle_override`,
flag). The worker (`workers/nightAuditSettle.ts`, hourly) settles audited days
and, after 06:00 PKT, raises ONE `night_audit_pending` per (company,
yesterday). It never audits a day. Nothing in this module posts.

Reopen (CEO): 422 `REASON_REQUIRED`, 409 `NOT_AUDITED`, 409
`DAY_IN_CLOSED_PERIOD`; history kept, `reopenCount` + 1, up to 5
`report.previousRuns`; audit `night_audit.reopen`, flag `night_audit_reopened`.

## CEO-only back-dated sales undo (`backdate.ts`, owner (c))

A back-dated sale: its sales day (completed ?? scheduled ?? placed, PKT) is
before today AND it is final (completed / refunded) or its day is locked. An
open ticket over midnight on a day not yet audited keeps normal manager rules.
Gated inside: `voidOrderItem` (`item_void`), `compOrder` (`comp`),
`cancelOrder` (`cancel` / `reject`, every caller except food a rider brought
back), `manualReverseCharge` (`card_reverse`; also an approved charge of an
earlier day), `issueCreditNoteForOrder` from the staff route (`credit_note`).
Without the CEO (signed in, or as the manager-PIN approver): 403
`CEO_ONLY_BACKDATED { day, orderRef, action }`; the CEO without
`backdatedReason` ≥ 10: 422 `BACKDATED_REASON_REQUIRED`. With it: audit
`sales.backdated.<action>` (category accounting) and flag
`backdated_sale_change` (high); posted today. The Raast receipt void and
`/reconciliation/backfill-unposted` were already CEO-only. Not gated (Q5):
refunds, payment settles, on-account charges, deposit drops, Raast
reconciliation, COD rider debt, delivered, food returned, box given, fiscal
retry. No sales route takes a client date; none may be added without the gate.

## Month close

`closeCheck.ts` `night_audit_days` (in `CLOSE_CHECKS`): active sales days from
max(prevLock + 1, start day) to the new lock not `closed` → block (CEO may
close over it). Start day null → warn.

## API — `/api/v1/accounting/night-audit` (module `accounting`, ACTIVE company)

```
GET  /?month=YYYY-MM          FINANCIALS_VIEWERS → MonthState
GET  /:day                    FINANCIALS_VIEWERS → DayDetail
GET  /:day/report?live=1      FINANCIALS_VIEWERS → { report, live }   404 NO_REPORT
POST /:day/run                admin, finance { acknowledge?: { keys, reason } } → DayDetail
POST /:day/settle             admin, finance { acknowledge? } → DayDetail
POST /:day/reopen             admin { reason } → DayDetail
PUT  /settings                admin { startDay: 'YYYY-MM-DD' | null, reason } → { startDay }
```
Shapes: `frontend/admin/src/app/finance/night-audit/types.ts` (MonthState,
DayDetail, DailyReport). 422 `NO_ACTIVE_COMPANY` without an active company.

## The bell (owner, 2026-10-16)

The night run tells the right people through the staff bell (`lib/staffNotify.ts`,
the one writer). Audience = the CEO(s) and the finance logins holding
`accounting` of THAT company (`nightAuditAudience`), minus whoever did it.
Built: "Sales day X audited" (net sales, orders, closed or awaiting settlement;
link `/finance/night-audit?day=`; dedupe per company/day/`reopenCount`, so a
reopen + rerun reports again) after a run, and "Sales day X closed" when a day
settles later (auto, manual or CEO override). `night_audit_pending` and the
override / reopen flags reach the bell through the exception notifier, not
from here. NOT built: "audited but still awaiting settlement" (`TODO(H45)` in
`workers/nightAuditSettle.ts`) — it waits for the accountant's answer on when
card payouts land. Notices are queued after the commit and never fail a run.

## Company merge

`mergeNightAuditDaysTx` (tenants/routes.ts, before the brands move): the
target's locked rows on the source's sales days reopen; source rows on a
shared date fold into the target's history; the rest move and open; start day
= the earlier.

## Owner questions (built on defaults)

Q1 Raast at night (SMS off: only awaiting / needs attention). Q2 till cash
deposited and matched before close. Q3 only days from the first run. Q4 an
unreviewed cash variance blocks. Q5 refunds of an older bill not CEO-only.
Q6 reservation deposits and gift-card / wallet sales outside sales.
