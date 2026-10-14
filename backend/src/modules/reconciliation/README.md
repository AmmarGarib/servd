# reconciliation

Backend module: **reconciliation**. HTTP routes + business logic for the Reconciliation domain. Registered into Fastify by `src/index.ts` under the `/reconciliation` URL prefix.

## Files

- `routes.ts` — Fastify route registrations for this module
- `service.ts` — Business-logic functions invoked by route handlers
- `backfillOrders.ts` — re-posts order completions, loyalty postings and refund restores the ledger refused (behind `POST /reconciliation/backfill-unposted`)
- `raast.ts` — Raast QR on the bank statement: the import's reference pass, the generic matcher's skip set, manual match / unmatch / reference fix / write-off, the CEO's "void, never booked", the daily `raast_unmatched` flag, the period-close count
- `raastRoutes.ts` — `/reconciliation/raast/*` (registered from `routes.ts`)
- `cardPayouts.ts` — card payouts at payout (H12): settings, card day gross, the fit rule, settle / undo, the manual claim, unsettled days, the `card_unsettled` close check
- `cardPayoutRoutes.ts` — `/reconciliation/card-payouts/*` (registered from `routes.ts`)
- `codRoutes.ts`, `pettyCashBackfillRoutes.ts` — wave-B child plugins of other owners

## Bank statements

`POST /reconciliation/bank/imports` runs ONE transaction: insert every line
`unmatched` → the **Raast pass** (only when the import names its bank account)
→ the **card-payout pass** (only on the company's payout bank while card
payout matching is on — see below) → the **generic pass** (signed amount +
3-day window against the reconciling account's journal lines). The card fits
are booked AFTER the commit, each in its own transaction; the result carries
`cardPayoutMatchedCount`. The generic pass skips lines the Raast and card
passes claimed (a credit with any card fit is left for finance),
never uses a journal line whose memo starts with `RAAST RECEIPTS`
(`RAAST_RECEIPTS_MEMO` — a shift's aggregated Raast debit, a write-off), and
(S3) leaves alone every credit equal to a provisional Raast receipt's amount on
that account within ±`statementMatchDays`, so it can't pair a customer's
transfer with an equal cash deposit. `POST /bank/lines/:id/unmatch`
(APPROVERS, audited) undoes a generic match; a line matched to a Raast receipt
answers 409 `RAAST_MATCHED_LINE` (unmatch it on the Raast tab), a card payout
409 `CARD_PAYOUT_LINE` (undo it on the Card payouts tab).

### Adjusting a line (BOOKS-11, `POST /bank/lines/:id/adjust`, APPROVERS)

`service.ts adjustStatementLine`: the statement line is one leg, the other is
one contra or a balanced split, posted `reconciliation.adjustment:<lineId>`
(`@n` after an undo) in the statement's company, dated the line's date.
ONE posting core (`postStatementEntryTx`: balance, active accounts, the bank
leg's journal line). A card-payout split (money in, one Cr 1030, at most one
Dr 6080) goes through **`postCardPayoutSplitTx`** — the same helper the card
matcher books with: there is one way to book a net Keenu payout.

- While card payout matching is on, a split that credits 1030 on the payout
  bank must name its card days (`cardDays`, + `cardUnit` per brand / machine):
  they are claimed (`CardSettlement` status `manual_adjust`) in the same
  transaction — else 409 `USE_CARD_PAYOUT_CONFIRM`. 1030 is never cleared twice.
- A split onto a fixed-asset register account (1500–1599, 2012) needs
  `registerOverride { reason ≥ 10 }` (else 422 `REGISTER_CONTROLLED_ACCOUNT`);
  it is audited (`reconciliation.adjustment.register_override`) and flagged
  `fixed_asset_gl_mismatch`.

## Card payouts at payout (`/reconciliation/card-payouts`, module `reconciliation`, H12)

Keenu pays a day's card money into the payout bank NET of the MDR and the tax
on it. `card.settlement:<lineId>[@n]` books **Dr payout bank net / Dr 6080 the
fee (MDR + its tax — all a cost, H12) / Cr 1030 the gross**, in the statement
import's company, dated the statement line, the line matched to the bank leg.

- **Settings** (`OperationsConfig.cardSettlement`, finance's): `enabled`,
  `payoutBankAccountId` (a live, linked bank of the company — 422
  `BANK_ACCOUNT_NOT_IN_COMPANY` / `BANK_ACCOUNT_NOT_A_BANK`), `unitMode`
  (`company` | `brand` | `terminal` — one Keenu MID per company / brand /
  machine), `mdrBps` 0–1000, `feeTaxBps` 0–3000, `lagDays` 1–5 (2),
  `toleranceBps` 0–200 (30), `maxBatchDays` 1–5 (3), `maxFeeBps` 0–1000 (500),
  `startDay` (today whenever matching is switched on; an earlier one only
  after the last manual 1030 split — 422 `START_DAY_BEFORE_MANUAL_SPLIT`).
- **Day gross** from card `Payment` rows of the company (method card + the
  retired keenu_qr's old rows; gateways card_terminal / keenu / none — never
  JazzCash, Easypaisa or Raast), paid (+) and refunded (−), by the PKT day of
  `processedAt ?? createdAt`; per unit (`brand:<conceptId>`,
  `terminal:<terminalId>` from TerminalCharge, `terminal:none`). Never 1030's
  entry dates (a shift close books card money at closedAt with no brand).
- **The fit — never a guess.** A credit on the payout bank dated D fits a run
  of 1..maxBatchDays unsettled days of ONE unit ending 1..lagDays+1 days
  before D (first and last day with money) when |net − gross × (1 − mdr × (1 +
  feeTax))| ≤ max(PKR 1, gross × tolerance) and the fee is within maxFeeBps.
  It is booked only when EXACTLY one run fits the line and no day of it is in
  another line's fits; every credit with a fit is kept from the generic pass.
  Raast's lines are never considered.
- **Refusals** (closed period, missing / inactive account, the card money
  changed): the line stays unmatched with the reason in its notes and ONE open
  `card_payout_unmatched` flag; nothing was posted, so there is no REPOSTER —
  `POST /rematch` and the period-close check are the queue.
- `GET /settings` (FINANCIALS_VIEWERS) / `PUT /settings` (admin, finance;
  audited `card_payouts.settings`).
- `GET /?from&to` (FINANCIALS_VIEWERS, view-aware) — settlements (with their
  days, line, bank) + each company's unsettled card days; `canConfirm`,
  `canUndo`, `canEditSettings`, `canRematch`.
- `GET /lines/:lineId/suggestions` (read scope, else 404) — runs of unsettled
  days the line could be (2 more days of lag, up to 5 days), `fits` flagged.
- `POST /lines/:lineId/confirm {days, unit?}` (admin, owner, finance; write
  scope) — 409 `LINE_NOT_UNMATCHED` / `DAY_ALREADY_SETTLED`; 422
  `NO_CARD_MONEY_ON_DAYS` / `FEE_OUT_OF_RANGE` / `PERIOD_LOCKED` /
  `CARD_PAYOUTS_OFF` / `NOT_THE_PAYOUT_BANK` / `CARD_DAYS_INVALID` /
  `CARD_UNIT_INVALID` / `DAY_BEFORE_START` / `DAYS_NOT_BEFORE_PAYOUT`.
- `POST /:settlementId/undo {reason}` (APPROVERS) — the entry reversed (today),
  the settlement deleted (its days free again), the line unmatched.
- `POST /rematch` (admin, finance; active company) — the payout bank's
  unmatched credits of the last 60 days.
- Period close: `cardPayoutCloseChecks` — `card_unsettled` (block,
  overridable): card days on or before lockedThrough − (lagDays + 3) with
  money and no payout, while matching is on.
- Locks: `pg_advisory_xact_lock(company, 'card-settlement')` around every
  claim; `CardSettlementDay @@unique([tenantId, unit, day])`; a day settled
  under another unit family (the mode was changed) counts as taken.

## Raast QR (`/reconciliation/raast`, module `reconciliation`)

A Raast payment completes the sale at the till and writes a `RaastReceipt`
**provisional**; the bank statement is the truth.

- **Automatic match — never a guess.** A credit line matches a receipt only
  when it names exactly ONE candidate's reference (`refInText`: 8+ characters
  as a substring of the text's letters/digits, shorter as a whole token), that
  receipt is named by no other line, the receipt is on the SAME company and
  receiving bank account, dated at most `statementMatchDays` PKT days after
  the receipt (`confirmedAt`, else `createdAt`) and NEVER before the bill
  existed (`createdAt − matchWindowMin`, by PKT day — M4, RV-FRAUD-1: an older
  credit's reference was borrowed), and the amounts are equal. One hit with a
  different amount → `raast_statement_mismatch`, nothing matched. A reference
  a manager dismissed as "not a sale", or a debit's, is never used (M4).
- **The generic matcher never touches a Raast line**: any credit that names a
  receipt's reference (matched or not — RV-FIN-2), and (S3) any credit equal
  to a provisional or written-off receipt's amount on that account within
  ±`statementMatchDays`. Only an UNMATCHED line can be ignored
  (`POST /bank/lines/:id/ignore` → 409 `RAAST_MATCHED_LINE` /
  `LINE_NOT_UNMATCHED`, RV-FIN-3).
- `GET /receipts?status&bankAccountId&from&to&q&cursor&limit` (FINANCE_TEAM,
  view-aware) — rows + totals by status + KPIs (provisional, older than
  `provisionalFlagDays`, matched, needs attention, not received, unmatched
  bank alerts).
- `GET /receipts/:id/candidates` — unmatched credit lines of the same company
  and account, equal amount, in the window; `refHit`, `sameDay`,
  `beforeBill` (dated before the bill — never a `refHit` or a suggestion), and S3's
  `suggested` line (no reference hit, exactly one same-day line, exactly one
  receipt of that amount that day). Finance confirms a suggestion with
  `/match`; nothing is matched automatically from it.
- `POST /receipts/:id/match {statementLineId}` (FINANCE_TEAM) — same company
  and account (422 `RAAST_LINE_NOT_ON_ACCOUNT`), line unmatched (409), equal
  amount (422 `RAAST_AMOUNT_MISMATCH`). A receipt written off as not received
  first reverses its write-off.
- `POST /receipts/:id/unmatch` (APPROVERS) — back to provisional.
- `PATCH /receipts/:id/reference {bankRef, reason}` (APPROVERS — M4) —
  provisional only, not once a bank SMS confirmed it (409
  `RAAST_SMS_CONFIRMED`); the till's checks (format, not the bill's own
  number, one transfer pays one bill per company → 409 `RAAST_REF_USED`, never
  a dismissed / debit reference → 409 `RAAST_REF_DISMISSED`, the bank SMS's
  amount when SMS matching is on); `Payment.gatewayRef` in the same
  transaction; the statement match is re-run for it. Audited before / after.
- `POST /receipts/:id/unreceived {reason, contraAccountCode: 1110|8010|1350}`
  (APPROVERS; default 1110 — "the customer owes it": till clearing lives on
  1110 while the 1115 split is PARKED with on-account clients, owner
  2026-10-13) — provisional only, and only once the
  entry that debited the bank for THIS receipt is posted (RV-MONEY-1; else 409
  `RAAST_SALE_NOT_BOOKED`): a till order's drawer close
  (`shift.close:<shiftId>`); any other live order's `order.complete:<orderId>`
  (a drawer close books non-till cash only); a cancelled non-till ticket only
  through a close that held it as a refund due (Cr till clearing —
  `TILL_CLEARING_CODES`, 1110 today — `REFUND DUE …` naming the order). Posts
  `raast.unreceived:<receiptId>` Dr contra / Cr the receipt's bank code (memos
  prefixed `RAAST RECEIPTS`), dated today, in the receipt's company. A
  reversal always mirrors its own entry's lines.
- **Void, never booked** (RV-MONEY-1; owner: the CEO only). For a provisional
  receipt on a cancelled / rejected bill that NO entry ever put in the bank.
  `POST /receipts/:id/void-request {reason ≥ 10}` (admin, owner, management,
  finance) asks; `POST /receipts/:id/void {reason ≥ 10}` (ADMIN_ONLY, with or
  without an ask) voids; `POST /receipts/:id/void-request/reject {note}`
  (ADMIN_ONLY) clears the ask. Refused (409) unless: provisional
  (`RAAST_NOT_PROVISIONAL`), not booked (`RAAST_SALE_BOOKED` — use not
  received), the bill cancelled / rejected (`RAAST_ORDER_NOT_CANCELLED`), every
  drawer holding its money closed with no open posting_failed on it or the bill
  (`RAAST_CLOSE_PENDING`), no refund row paid back against it
  (`RAAST_REFUND_EXISTS`, `gatewayMeta.raast.receiptId`). The void: status
  `voided` + reason / who / when, the bank reference kept (the till answers
  `RAAST_REF_USED`), its raast_* flags resolved, NO ledger posting (book a
  statement credit with the bank line's adjustment). It no longer counts for
  the period close or the daily flag. Audited `raast.receipt.void_request` /
  `.void` / `.void_request_reject` in the RECEIPT's company. The approvals
  inbox reads `GET /receipts?voidRequested=1`.
- Every receipt row carries `orderStatus`, `voidRequest {at, by, reason,
  pending}`, `voided {at, by, reason}`, `voidBlockedReason` and the caller's
  capability flags `canMatch`, `canUnmatch`, `canFixReference`, `canWriteOff`,
  `canResolve`, `canVoid`, `canRequestVoid`, `canRejectVoidRequest` (the admin
  page keeps no role list).
- `POST /receipts/:id/resolve {outcome: refunded_to_customer | not_a_sale |
  booked_elsewhere, reason, refundReference?}` (APPROVERS — RV-FIN-1) — a
  needs-attention receipt with no payment whose bill is closed (else 409
  `RAAST_ATTACH_AT_TILL`; not needs-attention → 409 `RAAST_NOT_ATTENTION`) →
  `cancelled` with `finance:<outcome>: <reason>`; its open bank SMS is closed
  (`dismissed`) and its reference claimed so it can never pay a bill; its
  flags resolve. No ledger posting (the transfer was never booked — book the
  statement credit / refund with the line's adjustment). Without it such a
  receipt held every later period close.
- `POST /rematch {importId?}` (FINANCE_TEAM) — the active company's unmatched
  credit lines of the last 60 days (or one of its imports).
- `GET /alerts?status` (FINANCE_TEAM) — the bank SMS log incl. unparsed bodies
  (read only — attaching is a till action).
- Every write takes the per-company Raast lock first
  (`connectors/raast/lock.ts`) and is on the books' audit trail
  (`raast.receipt.*`). A statement import takes it only for its Raast pass
  (inserting its own lines touches nothing the till writes — RV-FRAUD-6), so
  a big statement never stalls the tills' Raast payments.
- Daily 09:05 PKT (`workers/raastStatementFlags.ts`): ONE open
  `raast_unmatched` flag per bank account with provisional receipts older than
  `provisionalFlagDays` (count, total, oldest, "no statement imported since
  X"); resolved when none are left. An import refreshes it at once.
- Period close (`/accounting/period-close`): provisional / needs-attention
  receipts with `COALESCE(confirmedAt, createdAt)` up to the close date → 409
  `RAAST_UNMATCHED {count, cents}` unless the CEO sends
  `closeWithUnmatchedRaast: true` (audited `period.close_with_unmatched_raast`).
- `/summary` rows carry `raastSalesCents`; `totalSalesCents` includes Raast.

## CEO-only catch-up actions (role `admin`, dry run by default)

- `POST /reconciliation/backfill-unposted` — closed shifts, sales, points and refunds that never reached the ledger.
- `POST /reconciliation/backfill-petty-cash` `{ dryRun = true, historicTopupSource: 'safe' | 'garibsons' | { tenantId: … }, picks, tenantId? }` — books what was in the petty-cash boxes before the ledger tracked them (each box's opening and every unbooked movement), placed by owner decision 6. Dry run first; one audit row `petty_cash.backfill` per company; 409 `BACKFILL_RUNNING`. Registered from `pettyCashBackfillRoutes.ts`; the logic is `accounting/pettyCashPosting.ts backfillPettyCash`.

`POST /reconciliation/apply-missed-bill-variances` no longer exists: the catch-up it ran (bills booked before their goods whose carried price difference no receipt applied) now runs once, as step 0 of the FIFO cut-over (`inventory/fifoCutover.ts`). A refusal there is flagged `posting_failed` and kept in Setting `foodcost.preFifoCatchupRefused:<tenant>` for the align screen.
