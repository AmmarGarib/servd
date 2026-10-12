# reconciliation

Backend module: **reconciliation**. HTTP routes + business logic for the Reconciliation domain. Registered into Fastify by `src/index.ts` under the `/reconciliation` URL prefix.

## Files

- `routes.ts` — Fastify route registrations for this module
- `service.ts` — Business-logic functions invoked by route handlers
- `backfillOrders.ts` — re-posts order completions, loyalty postings and refund restores the ledger refused (behind `POST /reconciliation/backfill-unposted`)
- `raast.ts` — Raast QR on the bank statement: the import's reference pass, the generic matcher's skip set, manual match / unmatch / reference fix / write-off, the daily `raast_unmatched` flag, the period-close count
- `raastRoutes.ts` — `/reconciliation/raast/*` (registered from `routes.ts`)

## Bank statements

`POST /reconciliation/bank/imports` runs ONE transaction: insert every line
`unmatched` → the **Raast pass** (only when the import names its bank account)
→ the **generic pass** (signed amount + 3-day window against the reconciling
account's journal lines). The generic pass skips lines the Raast pass claimed,
never uses a journal line whose memo starts with `RAAST RECEIPTS`
(`RAAST_RECEIPTS_MEMO` — a shift's aggregated Raast debit, a write-off), and
(S3) leaves alone every credit equal to a provisional Raast receipt's amount on
that account within ±`statementMatchDays`, so it can't pair a customer's
transfer with an equal cash deposit. `POST /bank/lines/:id/unmatch`
(APPROVERS, audited) undoes a generic match; a line matched to a Raast receipt
answers 409 `RAAST_MATCHED_LINE` (unmatch it on the Raast tab).

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
  (APPROVERS) — provisional only, and only once the entry that debited the
  bank for THIS receipt is posted (RV-MONEY-1; else 409
  `RAAST_SALE_NOT_BOOKED`): a till order's drawer close
  (`shift.close:<shiftId>`); any other live order's `order.complete:<orderId>`
  (a drawer close books non-till cash only); a cancelled non-till ticket only
  through a close that held it as a refund due (Cr 1110 `REFUND DUE …` naming
  the order). Posts `raast.unreceived:<receiptId>` Dr contra /
  Cr the receipt's bank code (memos prefixed `RAAST RECEIPTS`), dated today,
  in the receipt's company.
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
- `POST /reconciliation/apply-missed-bill-variances` `{ dryRun = true, tenantId? }` — supplier bills booked before their goods whose carried price difference was never applied by a receipt (receipts before receiving did it itself). Runs `applyMissedCarriedBillVariances` per company in scope (a picked `tenantId` outside the scope is 404). Idempotent; a company whose books are closed through today lists its lines as `locked` and applies nothing. Shares the backfill's single-flight slot (409 `BACKFILL_RUNNING`).
