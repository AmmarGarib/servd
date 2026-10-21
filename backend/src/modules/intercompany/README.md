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
| `../../lib/companyPairs.ts` | `assertBothSidesOwned`, `isMemberOfBoth`, `memberTenantIdsOf`, `assertPairPreparer` (D1) — THE pair membership check (positions/contributions.ts uses it too) |

## Postings (both books, one serviceClient transaction, key `ic.transfer:<transferId>`)

DEBTOR = `IntercompanyTransfer.tenantId` (its *Due to <creditor>* moves);
CREDITOR = `counterpartyTenantId` (its *Due from <debtor>* moves).

| kind | debtor's book | creditor's book |
|---|---|---|
| charge | Dr `debtorAccountCode` (per debtor brand when `conceptSplit`) / Cr Due to creditor | Dr Due from debtor / Cr `creditorAccountCode` (no brand) |
| settlement | Dr Due to creditor / Cr its money account (`moneyAccountCode`; 1010 on a bank deposit) | Dr its money account / Cr Due from debtor |
| netting | Dr Due to creditor / Cr Due from creditor | Dr Due to debtor / Cr Due from debtor |
| reversal | `ic.transfer.reversal:<id>` in both (`reverseJournalEntry`) | same |

- Fleet charge (system): debtor = CLIENT (Dr **6035** per client brand), creditor = PROVIDER (Cr **6990** Costs Recharged to Group Companies — never 6035). Dated the month's last day (midday PKT), else the first day open in BOTH companies with a note naming the month.
- COD of a fleet rider (system): source `'cod'` is posted by `accounting/codPosting.ts` (debtor = rider's company Dr 1351, creditor = order's company Cr 1010), reversed when the cash is paid in.
- Head-office recharge (system, D1): source `'ho_recharge'`, one transfer per recharge-run line (`RechargeRunLine.transferId`), posted by `modules/headOffices/runs.ts` through `postSystemTransferTx` (debtor = the served company, Dr its "Head office charges — <HO>" account per the run; creditor = the head office, Cr its recharge account, default 6990). Reversed only from its run: `POST /transfers/:id/reverse` answers 409 `REVERSE_FROM_SOURCE` ("reverse the recharge run instead"), and `canReverse` is false.
- Fixed asset given by one company to another (system, owner 2026-10-21: "Book value, no gain or loss"): source `'asset_transfer'`, sourceRef `asset:<giverAssetId>`, posted by `fixedAssets/events.ts applyRelatedCompanyTransfer` through `postSystemTransferTx` in the CEO's approval transaction (debtor = the receiving company Dr **1395** Fixed Asset Transfer Clearing, creditor = the giving company Cr **1395**; the register's own legs clear 1395 in each book). Never reversed here: 409 `REVERSE_FROM_SOURCE`, `canReverse` false. Migration `20261021160000_ic_asset_transfer` widens `ic_source_chk`.
- Manual: dates are user-entered and never moved — a closed month in either company is 422 `PERIOD_LOCKED` naming the company, nothing saved. The claim (`submitted → posted`) and both postings share one transaction, so a refusal in either book rolls the claim back.
- Settlement ≤ what the debtor owes (both books, on the date and today, net of settlements / nettings still waiting) → 422 `SETTLEMENT_OVER_BALANCE`; netting ≤ the smaller direction → 422 `NETTING_OVER_BALANCE`. Re-checked at approval.

### Settlement methods and the payment reference # (owner, 2026-10-14)

`SETTLEMENT_METHODS = bank_transfer | bank_deposit | cheque | cash` (the receipt
methods of `lib/bankAccounts.ts` without card). The old `bank` is read as
`bank_transfer` at the route and in `createTransfer`
(`normalizeSettlementMethod`); stored rows keep `bank` and still post.

| method | debtor (payer) money line | creditor (payee) money line |
|---|---|---|
| bank_transfer, cheque | its named bank (`moneyAccountCode`) | its named bank |
| bank_deposit | **Cr 1010** — the payer's cash; naming a payer bank → 422 `BANK_ACCOUNT_ON_DEPOSIT` | **Dr its named bank** — the cash deposited at its branch |
| cash | Cr 1010 | Dr 1010 |

`settlementSideMethods(method)` is the one place that splits a method into the
two sides (create and posting both use it).

- `bankReference` is the **payment reference #**, required for **every**
  settlement method (cash included) when the transfer is created — 422
  `PAYMENT_REFERENCE_REQUIRED`, nothing saved. It is **never re-checked at
  approval**, so a settlement waiting from before the rule still approves.
- The reference and method are written into both entries' description
  (`Inter-company settlement: A → B (bank deposit, ref 4471) — memo`) and every
  line memo (e.g. `Cash deposited into B's bank (bank deposit, ref 4471)`).
  `journal_entries.reference` stays the key `ic.transfer:<id>`.
- `POST /transfers` answers `referenceUsedBefore` (`lib/paymentRefs.ts`, looked
  up in the companies of the pair the caller belongs to — both for a member of
  both, the head office only for a head-office preparer — this transfer left
  out): a warning, never a block.
- A reversed SYSTEM transfer frees its `sourceRef` (suffix `#reversed:<id>`), so the month / payment can be booked again once corrected (e.g. reverse a fleet charge → set the right rate → Charge now).

Controlled accounts (journal.ts): any posting touching a pair account must have a sourceType starting `ic.` (422 `INTERCOMPANY_ACCOUNT_CONTROLLED`, no override).

## Head-office pairs (D1; owner: reuse this engine)

A head office (`Tenant.kind 'head_office'`) and a company it serves through a
`HeadOfficeLink` use THIS engine — there is no second transfer table and no
`ic_transfer` approval type. Settlements are `kind 'settlement'`; a paired
adjustment (spec §4.6 `increase` / `decrease`) is `kind 'charge'` with the
debtor / creditor chosen by direction (the company owes the HO more → debtor
= company; less → debtor = HO). Both keep `source 'manual'`.

- **Prepare** (`POST /transfers`, admin / finance): `assertPairPreparer` —
  a member of both companies as before, OR a member of the head office whose
  ACTIVE company is that head office, for a company LIVE-linked to it
  (`lib/headOffice.ts liveLink`). `postNow` stays CEO only AND needs membership of both companies (403
  `NOT_IN_BOTH_COMPANIES`) — the head-office preparer path only submits.
- **Pair rule:** a transfer with a head office on one side needs a link
  (live or ended) between them, and never two head offices — 422
  `HEAD_OFFICE_NOT_LINKED`.
- **Counter accounts (A9):** a charge on a head-office pair may not name the
  head office's recharge account (`HeadOfficeBooks.rechargeAccountId`, else
  6990) or any of the pair's links' "Head office charges" accounts — 422
  `COUNTER_ACCOUNT_INVALID`. The due accounts are controlled and refused
  already (`ACCOUNT_CONTROLLED`).
- **Approve / reject:** `approvalSubject('intercompany_transfer', id)` →
  `assertCanApprove({…, ceoOnly: !headOfficePair})`. The CEO who belongs to
  both companies (role path) or, on a head-office pair only, a Finance
  delegate covering the company (`ApprovalDelegation`, HO-wide or scoped to
  that company). A company ↔ company transfer stays CEO only. The grant goes
  into `approveTransfer` / `rejectTransfer` (`{ grant }`); without one they
  require the CEO of both, as before. A non-admin never decides what they
  prepared — checked by `assertCanApprove` (403 `SELF_APPROVAL_BLOCKED`) AND
  in the claim (`preparedById <> me`). `selfApproved` stays for the CEO.
  Audit: `intercompany.transfer.approve|reject` in both companies with
  `metadata.decidedVia` ('role' | 'delegation', + `delegationId`), plus the
  one `approval.decide` row (`auditApproval`). No schema change.
- **Reverse:** CEO only and member of both, unchanged.
- **Who sees what (spec §4.8):** `GET /transfers`, `/transfers/:id`,
  `/balances` — a head-office member sees their head office's pairs with the
  companies it serves. Through the head-office lens (a served company they are
  not a member of) they see ONLY that company's pairs with their own head
  offices, read on `serviceClient` with an explicit pair filter; nothing else
  of the company's inter-company rows. `/balances` shows both sides of such a
  pair. Every `/balances` row carries `headOfficePair`: true when one side is
  a head office of the caller's with a live link to the other — also for the
  CEO who belongs to both (it marks the pair's kind, not why it is shown). `/companies` adds `headOfficePairs`
  (`[{ headOffice, companies }]`, live links). Every transfer row carries
  `canApprove` (decided by `lib/approvalRights.ts` for rows with a head
  office on one side).

With no head office linked (today) every path above is exactly the old one.

## The seam other modules call

```ts
// service.ts — inside the caller's serviceClient transaction; idempotent on (debtor, creditor, sourceRef)
postSystemTransferTx(serviceTx, { kind: 'charge', source: 'cod' | 'fleet' | 'ho_recharge', sourceRef, debtorTenantId, creditorTenantId,
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
| GET | `/companies` | FINANCIALS_VIEWERS | the caller's companies + `can.prepare` / `can.decide` + `headOfficePairs` |
| GET | `/balances?asOf=` | FINANCIALS_VIEWERS | both sides for a member of both, or on the caller's own head-office pair |
| GET | `/transfers?status=&limit=` | FINANCIALS_VIEWERS | either party in read scope (+ own head-office pairs); `{ items }` with `canApprove` / `canReverse` |
| GET | `/transfers/:id` | FINANCIALS_VIEWERS | 404 outside read scope |
| POST | `/transfers` | admin, finance | `assertPairPreparer`; `postNow` CEO only and member of both (403 `NOT_IN_BOTH_COMPANIES`); settlement: `method`, `bankReference` required (422 `PAYMENT_REFERENCE_REQUIRED`), 422 `BANK_ACCOUNT_ON_DEPOSIT`; HO pair: 422 `HEAD_OFFICE_NOT_LINKED`, `COUNTER_ACCOUNT_INVALID`; 201 + `referenceUsedBefore` |
| POST | `/transfers/:id/approve` | any staff role; `assertCanApprove` | CEO of both, or a Finance delegate on a head-office pair; 404 unseen, 403 `APPROVAL_NOT_YOURS` / `SELF_APPROVAL_BLOCKED`, 409 `NOT_SUBMITTED` |
| POST | `/transfers/:id/reject` | same as approve | `{ note ≥ 3 }` |
| POST | `/transfers/:id/reverse` | admin | member of both; `{ reason ≥ 10 }`; 409 `NOT_POSTED`, `REVERSE_FROM_SOURCE` (COD, head-office recharge) |
| GET | `/fleet?from=&to=` | FINANCIALS_VIEWERS | agreements touching read scope |
| PUT | `/fleet/:agreementId/rate` | admin | `assertBothSidesOwned`; 409 `RATE_EXISTS` / `RATE_PERIOD_CHARGED` |
| POST | `/fleet/charge` | admin | `{ month?, agreementId? }`; 422 `MONTH_NOT_ENDED`; idempotent |
| GET | `/tie-out?asOf=` | FINANCIALS_VIEWERS | per company in read scope |
| POST | `/legacy-writeoff` | admin | `{ code, reason, dryRun, tenantId? }` |

## Open questions (defaults built)

- Q2 fleet charge = CEO-set rate per trip (not actual wages shared by trips).
- Q3 fleet charge = cost recovery (6990), no sales tax — confirm with the CA.
- Q4 manual transfers: finance prepares, the CEO approves (or posts at once); on a head-office pair a Finance delegate may approve (D3).
- Q5 TenantContribution stays planning-only.
- The All-companies balance sheet shows due-from / due-to gross: there are no consolidation eliminations.
