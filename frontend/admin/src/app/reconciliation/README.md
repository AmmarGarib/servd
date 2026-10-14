# reconciliation

Admin route: **/reconciliation** (`?tab=shifts|bank|cards|raast`). Module
`reconciliation`. Next.js App Router page module — `page.tsx` is the entry.

## Files

- `page.tsx` — the tabs: POS shifts (with a Raast column), bank statement
  imports, Card payouts and Raast.
  - Statement lines: a line matched to a Raast payment carries a "Raast #ref"
    chip; a line that settles card days carries a **"Card payout <days>"** chip
    (`line.cardSettlement` from `GET /reconciliation/bank/imports/:id/lines`)
    and is undone on the Card payouts tab, never by Unmatch (409
    `CARD_PAYOUT_LINE`, shown in words). A generic match can be undone by the
    CEO / co-owners (`POST /reconciliation/bank/lines/:id/unmatch`).
  - An unmatched CREDIT on the payout bank (card payout matching on) offers
    **"Card payout?"**: `GET /reconciliation/card-payouts/lines/:id/suggestions`
    → pick a run of card days → `POST …/lines/:id/confirm { days, unit }`.
    "Book adjustment" on such a line answers 409 `USE_CARD_PAYOUT_CONFIRM`
    (1030 is never cleared twice) — shown in words.
  - The adjustment form warns on a credit of a Raast receiving account (an
    adjustment would book a customer's transfer twice).
  - **No COD tab.** COD custody is PARKED (owner, 2026-10-13);
    `/reconciliation/cod` is an empty server stub. Build it only when the
    owner resumes delivery.
- `CardPayouts.tsx` — the Card payouts tab (H12): settings (payout bank via
  `BankAccountSelect`, how Keenu pays — company / brand / card machine, MDR %,
  tax on the fee %, lag days, batch days, tolerance %, largest fee %, start
  day; `GET/PUT /reconciliation/card-payouts/settings`, editable when the API's
  `canEdit` is true — admin, finance), the settlements of the last 90 days
  (gross, fee incl. its tax, received), card days not paid out yet, **Re-run
  matching** (`canRematch`) and **Undo** (`canUndo`, approvers; reason ≥ 3).
  The fee and the tax on it are a cost on 6080, booked at payout. Also exports
  `CardPayoutChip`, `CardPayoutSuggest`, `useCardPayoutBanks` and
  `cardPayoutErrorText` for `page.tsx`. Every figure is the server's.
- `RaastTab.tsx` — Raast QR payments (`/reconciliation/raast/*`): KPIs, the
  receipts with filters and their actions (Match, Fix reference, Not received,
  Unmatch, Re-run matching) and the read-only bank SMS log.
  - **Void vs not received.** "Not received" writes off a Raast payment the
    bank never credited: `raast.unreceived:<receiptId>` in the receipt's
    company, Dr the contra / Cr the receiving bank's code. The contra is 1110
    (the customer still owes it — till clearing stays on **1110** while the
    1115 till-clearing split is PARKED), 8010 (loss) or 1350 (staff owes). A
    **void** ("void, never booked") is for a PROVISIONAL receipt on a
    cancelled / rejected bill whose money no entry ever debited to the bank:
    finance may ask, only the CEO voids, and NOTHING is posted (the bank
    reference stays used). When an entry did debit the bank, use "not
    received". A voided receipt drops out of the till's refund-due, the
    Z-report and the period close.
- `BackfillUnposted.tsx` — the CEO's backfills (role `admin`; the shifts tab):
  - **Postings that never reached the books** —
    `POST /reconciliation/backfill-unposted` (preview, then post): closed
    shifts, sales, points, refunds, deposits, waste, stock counts, cancelled
    orders and failed card payments.
  - **Petty-cash history** — `POST /reconciliation/backfill-petty-cash`
    (dry run by default): per company, where the money already in the boxes
    came from (`historicTopupSource`: the safe 1010 — the default, H2 — or the
    Garibsons cashier 2210, H1), the resulting 1010 balance with a warning when
    it would go negative, a pick for every `needs_category` spend (an expense
    category, or an account — 5010/5020/5030 for pre-FIFO kitchen buys) and
    every `needs_review` one-sided transfer / return (safe, Garibsons or a
    bank), then Post. A changed pick needs a new dry run before Post. 409
    `BACKFILL_RUNNING` while another backfill runs for the company.

The supplier-bill "missed variances" catch-up (`MissedBillVariances.tsx`,
`POST /reconciliation/apply-missed-bill-variances`) is gone: it now runs once
as step 0 of the FIFO cut-over (`inventory/fifoCutover.ts`).
