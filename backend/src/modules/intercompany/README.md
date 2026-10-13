# Inter-company (H30) — `modules/intercompany`

Money that moves between two group companies' books: the shared rider fleet,
a fleet rider's unpaid cash-on-delivery, charges, settlements and netting
between companies, plus the tie-out of the wallet / loyalty / gift-card
liabilities and the one-off write-off of the pre-split cross-company residue.
Admin page: **Accounting → Inter-company** (`/accounting/intercompany`).
Mounted at `/accounting/intercompany` (module gate `accounting`; no widening).

`TenantContribution` (Positions → contributions) is a **planning figure only**
and posts nothing; whether it should post monthly as inter-company charges is
owner question Q5 (open).

## Files

| File | What |
|---|---|
| `accounts.ts` | `ensurePairAccounts(tx, a, b)` — 'Due from / Due to <company>' in BOTH charts (1450–1499 / 2150–2199, `controlledBy 'intercompany'`, `counterpartyTenantId`), under `lockPair` (`pg_advisory_xact_lock(hashtext('ic.pair:<min>:<max>'))`); `sideBalances`, `pairBalances`, `counterpartiesOf` |
| `service.ts` | transfers: `createTransfer`, `approveTransfer`, `rejectTransfer`, `reverseTransfer`; the system seam `postSystemTransferTx` / `reverseSystemTransfer`; `commonOpenPlacement`; `presentTransfers` |
| `fleet.ts` | shared-fleet rates, trips, `chargeFleetMonth`, `chargeAllEnded`, `runFleetChargesOnce`, `fleetChargeRefusedDoc` (re-poster document) |
| `legacy.ts` | `controlTieOut`, `legacyDifference`, `legacyEvidence`, `writeOffLegacy` |
| `closeChecks.ts` | `intercompanyCloseChecks` for `accounting/closeChecks.ts` |
| `routes.ts` | `intercompanyRoutes` |
| `../../workers/intercompanyFleet.ts` | `startIntercompanyFleetWorker` (03:40 PKT): fleet charges + the pair mismatch flag |
| `../../lib/companyPairs.ts` | `assertBothSidesOwned`, `isMemberOfBoth`, `memberTenantIdsOf` — THE pair membership check (positions/contributions.ts uses it too) |

## Postings (both books, one serviceClient transaction, key `ic.transfer:<transferId>`)

DEBTOR = `IntercompanyTransfer.tenantId` (its *Due to <creditor>* moves);
CREDITOR = `counterpartyTenantId` (its *Due from <debtor>* moves).

| kind | debtor's book | creditor's book |
|---|---|---|
| charge | Dr `debtorAccountCode` (per debtor brand when `conceptSplit`) / Cr Due to creditor | Dr Due from debtor / Cr `creditorAccountCode` (no brand) |
| settlement | Dr Due to creditor / Cr its money account (`moneyAccountCode`) | Dr its money account / Cr Due from debtor |
| netting | Dr Due to creditor / Cr Due from creditor | Dr Due to debtor / Cr Due from debtor |
| reversal | `ic.transfer.reversal:<id>` in both (`reverseJournalEntry`) | same |

- Fleet charge (system): debtor = CLIENT (Dr **6035** per client brand), creditor = PROVIDER (Cr **6990** Costs Recharged to Group Companies — never 6035). Dated the month's last day (midday PKT), else the first day open in BOTH companies with a note naming the month.
- COD of a fleet rider (system, w2-dlv-cod): debtor = PROVIDER (Dr **1351** — the rider owes it), creditor = CLIENT (Cr **1010** — the cash it never got).
- Manual: dates are user-entered and never moved — a closed month in either company is 422 `PERIOD_LOCKED` naming the company, nothing saved. The claim (`submitted → posted`) and both postings share one transaction, so a refusal in either book rolls the claim back.
- Settlement ≤ what the debtor owes (both books, on the date and today, net of settlements / nettings still waiting) → 422 `SETTLEMENT_OVER_BALANCE`; netting ≤ the smaller direction → 422 `NETTING_OVER_BALANCE`. Re-checked at approval.
- A reversed SYSTEM transfer frees its `sourceRef` (suffix `#reversed:<id>`), so the month / payment can be booked again once corrected (e.g. reverse a fleet charge → set the right rate → Charge now).

Controlled accounts (journal.ts): any posting touching a pair account must have a sourceType starting `ic.` (422 `INTERCOMPANY_ACCOUNT_CONTROLLED`, no override).

## The seam other modules call

```ts
// service.ts — inside the caller's serviceClient transaction; idempotent on (debtor, creditor, sourceRef)
postSystemTransferTx(serviceTx, { kind: 'charge', source: 'cod' | 'fleet', sourceRef, debtorTenantId, creditorTenantId,
  amountCents, entryDate, debtorAccountCode, creditorAccountCode, conceptSplit?, memo, preparedById, period?, memoNote? })
  → { transferId, debtorEntryId, creditorEntryId, alreadyPosted }
reverseSystemTransfer(transferId, reason, { entryDate?, tx? })   // idempotent; first day open in both when entryDate is closed
```

A caller acting for a person checks `isMemberOfBoth(user, a, b)` first (403 `NOT_IN_BOTH_COMPANIES`).

## Fleet re-poster (w4-integration wires it into `REPOSTERS`)

```ts
'ic.fleet_charge': {
  entityType: FLEET_CHARGE_ENTITY,              // 'FleetCharge'; flag entityId = sourceId = '<agreementId>:<YYYY-MM>'
  title: 'Shared-fleet charge refused',
  nothingToPost: FLEET_NOTHING_TO_POST,         // agreement_not_found | no_rate | no_trips | already_charged
  load: (sourceId) => fleetChargeRefusedDoc(sourceId),
}
```

`fleetChargeRefusedDoc` sets `nothingOwed` when the transfer with sourceRef
`fleet:<…>` is posted (the backfill's own "already on the books" lookup by
`ic.fleet_charge:<…>` never matches — the entry is `ic.transfer:<id>`), returns
`date: null` so `placeAndPost` passes the operator as `postedBy`, and its
`post()` refuses (`FLEET_ASK_CEO`, not in nothingToPost — the flag stays open)
unless that operator belongs to BOTH companies; it then calls
`chargeFleetMonth`, which re-derives the first day open in both companies.

## Close checks

`intercompany_pending` (block), `fleet_recharge` (block; fix POST
`/accounting/intercompany/fleet/charge`), `fleet_no_rate` (warn),
`intercompany_mismatch` (warn), `intercompany_unsettled` (warn),
`control_tieout` (warn). Blocks are overridable by the CEO with a reason.

## Legacy residue (H30 default)

Measured AS AT the split migration (`_prisma_migrations.finished_at` of
`20261010150300_loyalty_per_company` for 2060, `20261011160000_customer_wallet_per_company`
for 2050; the name's timestamp when the table is absent). Ledger > subledger →
Dr 2050/2060 / Cr 6060; lower → Dr 6060 / Cr 2050/2060. Key
`legacy.cross_company_writeoff:<tenantId>:<code>`, once (409
`ALREADY_WRITTEN_OFF`), CEO + reason, dated today. Later drift stays the
`control_tieout` warning. 2080 reuses `giftCards/books.ts giftCardBooksCheck`
(as of now) — never a second gift-card tie-out.

## Routes

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/companies` | FINANCIALS_VIEWERS | the caller's companies + `can.prepare` / `can.decide` |
| GET | `/balances?asOf=` | FINANCIALS_VIEWERS | both sides only for a member of both |
| GET | `/transfers?status=&limit=` | FINANCIALS_VIEWERS | either party in read scope; `{ items }` with `canApprove` / `canReverse` |
| GET | `/transfers/:id` | FINANCIALS_VIEWERS | 404 outside read scope |
| POST | `/transfers` | admin, finance | `assertBothSidesOwned`; `postNow` CEO only |
| POST | `/transfers/:id/approve` | admin | member of both; 409 `NOT_SUBMITTED` |
| POST | `/transfers/:id/reject` | admin | `{ note ≥ 3 }` |
| POST | `/transfers/:id/reverse` | admin | `{ reason ≥ 10 }`; 409 `NOT_POSTED`, `REVERSE_FROM_SOURCE` (COD) |
| GET | `/fleet?from=&to=` | FINANCIALS_VIEWERS | agreements touching read scope |
| PUT | `/fleet/:agreementId/rate` | admin | `assertBothSidesOwned`; 409 `RATE_EXISTS` / `RATE_PERIOD_CHARGED` |
| POST | `/fleet/charge` | admin | `{ month?, agreementId? }`; 422 `MONTH_NOT_ENDED`; idempotent |
| GET | `/tie-out?asOf=` | FINANCIALS_VIEWERS | per company in read scope |
| POST | `/legacy-writeoff` | admin | `{ code, reason, dryRun, tenantId? }` |

## Open questions (defaults built)

- Q2 fleet charge = CEO-set rate per trip (not actual wages shared by trips).
- Q3 fleet charge = cost recovery (6990), no sales tax — confirm with the CA.
- Q4 manual transfers: finance prepares, the CEO approves (or posts at once).
- Q5 TenantContribution stays planning-only.
- The All-companies balance sheet shows due-from / due-to gross: there are no consolidation eliminations.
