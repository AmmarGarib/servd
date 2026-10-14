# Wave B builder brief — w2-oa-recv: On-account clients, cards, exposure, statements, bad-debt write-offs; sales tax withheld by clients

Repo `/home/user/servd` — backend = Fastify + Prisma in `backend/`, admin = Next.js in `frontend/admin/`, storefront in
`frontend/storefront/`, `tablet/`, `mobile/`, `rider/` Expo apps. Read `/home/user/servd/CLAUDE.md` first: it applies in full.
Wave: **W2** · Area: **onaccount (receivables) + tax (H13 customer withholding)** · Test DB **`servd_test_wb_w2_oa_recv`** · Redis **`redis://127.0.0.1:6390/14`** (index 14) — yours alone
Design inputs (read the parts named below): `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/plan_<area>.json` (area plans), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/critic_*.json` (critic corrections —
already folded into this brief), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/schema-merged.prisma.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/chart-merged.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/shared-files.md`,
`/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/build-waves.md`. Where this brief and an area plan differ, THIS BRIEF wins (it carries the critic corrections and the
cross-area merges). Line numbers quoted from plans may have drifted: find the code by name.

## Your job in one line

receivables/routes.ts, onAccount.ts (exposure / chargeable / charge / charge refund), customerAccounts.ts, statements.ts, writeOffs.ts, onAccountDaily worker.

W1 is merged: code against the W1 contracts as they are ON DISK (read the files). Files you own may change hands in W3/W4 (shared-files.md).


## Binding decisions (read before anything else)

Owner decisions 2026-10-13 (/home/user/servd/.handoff/fixes/owner-decisions-20261013.md), as merged by the integration architect:
- Upgrade the EXISTING fixed-asset register and food cost (no duplicates; food cost = one variance report under Reports; the old
  /accounting/food-cost link forwards).
- Cash requests replace the voucher flow: anyone raises → HOD signs → director (CEO) approves → Jamil sb (box custodian) pays and marks
  paid (no photo) → the holder uploads receipts → that books the expense (advance on 1355 until then, H3/H4).
- Petty cash is funded by the Garibsons cashier (GS Foods holds no cash): Dr 1011 / Cr 2210 Due to Garibsons (H1). servd records only the cash-in.
- Delivery completes ONLY with the customer's code; no staff "Delivered" override. Refused/unpaid → the rider brings the food back → booked as
  food WASTE by the RGM / chef / F&B manager through the new "Emergency overrides" section (send the code to the rider's number; log
  returned food). Strikes: refused-at-door = strike; 3 strikes block the customer (account, email, number) PER COMPANY; a blocked customer can
  appeal to the help desk.
- Fixed assets: depreciation AUTOMATIC monthly; no threshold; smallwares grouped in pools; big items individual; disposals/scraps/write-downs:
  finance requests, CEO approves (F&B manager NOT); no opening/pre-servd assets; equipment only via CapEx.
- Food cost: split food / drinks / packaging; real-time at the PO price of the lots actually cooked (FIFO); per-outlet stock is the NEXT build
  (tag the outlet now).
- Delivery fee carries sales tax, ADDED ON TOP. On-account corporate clients with a credit limit and a QR card the cashier scans; no manager
  approval per bill; finance invoices monthly (statements). Bad-debt write-off: the CEO approves every one. Raast "void, never booked": CEO only.
  Wrong-brand Raast QR: no change. G15 (dead "Purchase order coming soon" button) → fix.

**PACKAGING RULE — FINAL (owner, 2026-10-13, the LAST answer; it overrides every earlier packaging message, including the
"no exceptions / no brand setting" message the owner withdrew: "Ok nvm do what we originally planned and [do] the brand primary setting
thing. With the button it makes sense"):**
- every finished (plate) recipe ALWAYS has an optional Packaging section (all brands, plated ones like Simmer included);
- whether a sale uses its packaging depends on the ORDER TYPE and the BRAND: `packagingApplies(order, concept, line)` in lib/recipeCost.ts =
  order is takeaway or delivery (incl. storefront pickup/delivery, rider, WhatsApp pickup) → TRUE; else the brand's primary service vessel is
  'packaging' (e.g. Stackd — packaging IS the service vessel) → TRUE; else (dine-in at a plate brand) → TRUE only when staff tapped
  "Box given" on that line (leftovers boxed);
- Concept.serviceVessel 'plate' | 'packaging' (NOT NULL, default 'plate'): a REQUIRED choice when a brand is created (create-brand form + API)
  and editable in Marketing → Brands; backfill stackd = 'packaging', every other brand 'plate'; a change applies from then on (the vessel is
  snapshotted on the order line, never restating past cost);
- OrderItem.boxGiven (Boolean default false) + boxGivenAt / boxGivenById: the "Box given" button on the till / admin order / KDS-expo for
  dine-in lines (any staff of the order's company; audited; undo allowed until the order completes); it depletes the line's packaging lots
  (FIFO, Dr 5030 / Cr 1230) and adds the packaging to the line's actual MC;
- stock depletion and the books follow the same rule: a line whose packaging does not apply depletes no packaging;
- TARGET MC (material cost) = food + drinks + packaging-if-it-applies-to-that-order-type; ACTUAL MC = food + drinks + packaging actually used;
  the variance report shows MC by order type (dine-in / takeaway / delivery) and by brand;
- a recipe needs no packaging lines to be approved (a plate brand with dine-in only is valid); a packaging-vessel brand's recipe WITHOUT
  packaging lines raises a warning on the recipe and in the report (not a block);
- the existing `Recipe.qFactorPct` stays the ONLY pricing allowance (the "Q factor" that pays off the plate, H18): pricing/theoretical only,
  never posted; plate cost reaches the books through smallwares depreciation.

Accountant defaults in force (Hasnain H1–H30, 'In servd now'; Hasnain may change later — keep each one a single switch point):
H1 Garibsons cash → 2210 Due to Garibsons · H2 own petty-cash account 1011; boxes' history treated as from the safe (1010) · H3 cash request =
advance on 1355; receipt books Dr expense / Cr 1355; change back to the box; unsettled after 30 days becomes a staff advance (HR loan, 1350)
or the director's current account (1356) · H4 director's current account · H5 delivered COD not handed in = receivable from the rider (1351) ·
H6 gratuity at exit (30 days' last gross per completed year, > 6 months counts, permanent staff with 1+ year, booked when the F&F is approved) ·
H7 2042 salary tax / 2043 EOBI / 2044 SESSI-PESSI · H8 input tax by charging authority (1320–1324), set off only against that authority;
OpEx/CapEx withhold income tax at the vendor's filer rate (s.153/s.155) · H9 delivery-fee GST at the order's tender rate (15% cash / 8% card,
Raast, online) · H10 kept no-show deposit taxable, tax inside, brand revenue · H11 breakage of sold gift cards → 4200 at expiry, no sales tax
(promotional → 6060) · H12 card MDR booked at payout; tax on the fee is a cost (6080) · H13 customer-withheld sales tax → 1335, netted in that
authority's return · H14 on-account tax invoice at supply (the fiscal POS files at the till; the statement is not a tax invoice) · H15 direct
write-off with reason + evidence, no provision · H16 FIFO lots · H17 goods booked on arrival against 2015 GRNI, cleared by the bill · H18 plate
wear via smallwares depreciation; Q factor pricing only · H19 opening stock found by the first count → 3020 (items never counted/received) ·
H20 brand-less waste/count differences split by each brand's recipe use (30 days); untraceable stays head office · H21 smallwares pools per
outlet/type, 24 months · H22 lives: kitchen 5y, furniture 7, IT 3, vehicles 5, fit-out 10 (or lease end), generators 7, office 5, buildings 20,
smallwares 2, land none · H23 ITO Third Schedule rates + 25% initial allowance on eligible plant · H24 deferred tax report only at 29% ·
H25 rent advance spread monthly to 6010; refundable deposits 1360; no IFRS 16 · H26 architect/design/project fees capitalised on build-outs;
legal/broker expensed · H27 accumulated depreciation per class 1591+ (one-off move out of 1590) · H28 WHT on CapEx at the vendor's filer
rate, 0 with an exemption certificate · H29 30 June year end, virtual roll-forward · H30 due-to/due-from per company pair, settled monthly;
old pre-launch cross-company balances written off inside each company.


## Already done by the orchestrator in wave 0 (use it, never redo or edit it)

- `backend/prisma/schema.prisma` + migrations `20261014085900_finance_wave_b_enums` and `20261014090000_finance_wave_b`, client generated —
  exactly `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/schema-merged.prisma.md`. If you truly need another column/table/index, STOP and say so in your report.
- `backend/src/lib/chartOfAccounts.ts` (new codes, REQUIRED list, `assertTemplateAccounts`, `REGISTER_CONTROLLED_CODES`) and
  `backend/src/modules/accounting/journal.ts` (ACCT constants, `TILL_CLEARING_CODES`, `ON_ACCOUNT_MEMO`, `CONTROLLED_PREFIX`, the
  controlled-account rule with `controlledOverride`, `lateDatingFor`) — exactly `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/chart-merged.md`.
- `accounting/sourcePosting.ts`: `syncSourcePosting(…, { keepLiveDate })`, `liveRevision(…, tx)` / `liveRevisionsFor(…, tx)`.
- `lib/bankAccounts.ts` `ledgerBalancesByCode(tenantId, codes, { asOf })`; `lib/exceptions.ts` every new ExceptionKind; `lib/inventoryClass.ts`
  (INVENTORY_CATEGORIES, costClassOf, CLASS_ACCOUNTS, CLASS_LABEL); `lib/savepoint.ts` (withSavepoint); `lib/evidenceFile.ts`
  (decodeEvidenceFile, sendEvidence); `lib/onAccountCard.ts`; `lib/tenders.ts` (ON_ACCOUNT_TENDER, REFUND_TENDERS); `accounting/closeCheckTypes.ts`
  (CloseCheck, CloseProblem, CloseCheckContext); `accounting/fiscalYear.ts` (pure fiscalYearOf, taxYearOf, isFiscalYearEndInRange);
  `approvals/types.ts` APPROVAL_TYPES; `lib/moduleAccess.ts` + `lib/workspaces.ts` (module ids food_cost + emergency_overrides, GATED rules);
  `reconciliation/routes.ts` registering stub child plugins (cardPayoutRoutes, codRoutes, pettyCashBackfillRoutes);
  `reconciliation/backfillOrders.ts` exporting placeAndPost / Reposter / RefusedDoc / withBackfillSlot; `tests/setup.ts` (seeds every template
  code, applies the SQL-only CHECKs + partial uniques); `tests/moneyBigint.test.ts` canary; admin `lib/appRoles.ts`, `lib/moduleCatalog.ts`,
  `next.config.js` redirect, `app/exceptions/page.tsx` labels; `packages/types` order modifierId + delivery fee fields.
- `backend/src/index.ts` is NOT touched until wave Z: tests register the plugin they test on their own Fastify instance (see
  tests/connectorsFixtures.ts buildApp). Give the orchestrator the exact registration / worker-start / boot / /health snippet in your report.

## You own (edit only these)

- `backend/src/modules/receivables/routes.ts`
- `backend/src/modules/receivables/onAccount.ts (new)`
- `backend/src/modules/receivables/customerAccounts.ts (new)`
- `backend/src/modules/receivables/statements.ts (new)`
- `backend/src/modules/receivables/writeOffs.ts (new)`
- `backend/src/workers/onAccountDaily.ts (new)`
- `backend/tests/onAccountClients.test.ts (new)`
- `backend/tests/onAccountExposure.test.ts (new)`
- `backend/tests/onAccountStatements.test.ts (new)`
- `backend/tests/badDebtWriteOff.test.ts (new)`
- `backend/tests/receivablesSalesTaxWithheld.test.ts (new)`
- `backend/tests/receivablesCredit.test.ts`

## Read first

- plan_onaccount.json: summary, schema, postings (statement, payment, write-off, recovery), routes (customer-accounts, receivables, write-offs), build_split B (+ A's onAccount.ts)
- plan_tax.json: summary 6, routes (receivables withholding), shared_file_changes receivables/routes.ts
- critic_cash_delivery_onaccount_2.json: violations 1, 2; missing (recovery reversal, statements claim booked charges only, statement H13 authority, capability flags, fnb_manager narrowing, revoked-card dedupe, platform SMTP)
- critic_tax_people_0.json violation 9 ('st_withheld')

## What to build

**receivables/routes.ts:** EXPORT the private helpers (lockInvoice, restatus, nextNumber (prefix AR-ST- for statements), withNumberRetry,
assertLiveInvoice) instead of moving them (critic — less churn); balanceOf = total − paid − credited − withheld − writtenOff (0 for void / credit
notes); statusFor 'written_off' when writtenOff > 0 and balance ≤ 0; LIVE_KINDS = ['invoice','statement'] in list/aging; assertLiveInvoice accepts
statements; credit-notes refuse statements (409 STATEMENT_CREDIT_AT_TILL 'refund the bill at the till so the fiscal return files'); a statement
voids only with nothing received/withheld/credited/written off and RELEASES its charges (statementInvoiceId = null) with no reversal entry; the
invoice void claim also requires writtenOffCents 0; POST / accepts customerAccountId (same company as the active company else 422
CLIENT_NOT_IN_COMPANY; copies name/NTN); register writeOffs as a child plugin; header comment (G12/G14/G13 no longer 'not here yet').
**H13 (TX):** the withholding route body gains kind 'income_tax' (default, today's) | 'sales_tax' → ReceivablePayment method **'st_withheld'**
(never 'stwh') + taxAuthority; authority = the output account the invoice's 'receivable.issue' entry credited; for a STATEMENT (no issue entry) the
authority comes from its charges' brands via outputTaxCodeFor — 422 STATEMENT_MULTI_AUTHORITY when they span two; caps 422 NO_OUTPUT_TAX / 409
OVER_SALES_TAX_WITHHOLDING (> tax − credited tax − live st_withheld rows) / 409 OVER_WITHHOLDING; posts 'receivable.st_withheld:<paymentId>' Dr 1335 /
Cr 1110 (1110 line conceptId = invoice.conceptId) in the invoice-locked tx; `paymentKind` returns 'withholding' for 'wht' and 'st_withheld';
`sourceOfPayment(p)`; the reverse route reverses 'receivable.st_withheld'. Pre-check 1335 with assertTemplateAccounts (422, nothing saved).
**Recovery reversal (critic):** reversing a payment that carries writeOffId also decrements ReceivableWriteOff.recoveredCents and restores the
invoice's writtenOffCents in the same tx.
**receivables/onAccount.ts (used by the till in W3):** `CHARGE_ERRORS`; `lockAccountTx(tx, id)` (SELECT … FOR UPDATE); `exposureOfTx(db, accountId)` →
{unbilledCents (Σ amount − refunded of unbilled charges), invoicesDueCents (Σ max(0, balanceOf) of linked open/partial invoice + statement rows),
exposureCents, overdue {invoiceId, number, dueDate, balanceCents} | null (dueDate + overdueGraceDays < today PKT)}; `assertChargeableTx(tx, account,
{ conceptId, billCents, reference })` (409 ON_ACCOUNT_NOT_ACTIVE / ON_ACCOUNT_BRAND_NOT_ALLOWED / ON_ACCOUNT_OVERDUE {statementNumber, dueDate,
balanceCents} / ON_ACCOUNT_OVER_LIMIT {limitCents, exposureCents, availableCents, billCents}; 422 ON_ACCOUNT_REFERENCE_REQUIRED) — BLOCK, not warn
(owner Q3 default); `recordChargeTx(tx, {...})` (CustomerAccountCharge + card.lastUsedAt); `applyChargeRefundTx(tx, { orderId, refundPaymentId,
amountCents })` (refundedCents capped; when billed: lockInvoice + statement creditedCents + restatus); `flagRevokedCardUse(tenantId, cardId)` (one
open 'on_account_card_revoked_used' per card per day — critic dedupe). No import from pos/service (no cycle). Lock order order → client account →
invoice (header comment).
**customerAccounts.ts** (wave Z registers at /accounting/customer-accounts; '/accounting' gate): list/create/get/patch per the OA plan routes;
create binds to the ACTIVE company, conceptIds through assertConceptOwned 'create' (foreign → 422); status pending unless the actor is admin (then
active + approvedBy); a limit increase → requestedCreditLimitCents (CEO applies), a decrease at once; suspend (any editor + reason), reactivate
(admin only, 403), close (exposure 0 else 409 CLIENT_HAS_BALANCE); approve/reject (ADMIN_ONLY); cards issue/rotate/revoke via lib/onAccountCard.ts —
the code is returned ONCE and never stored, logged or audited (audit holds the hint); charges list; tie-out (1110 GL vs open invoices + statements
+ booked unbilled charges; unbilled not-yet-booked shown apart); remind (1/client/day, 409 REMINDED_TODAY); number OA-0001 under
pg_advisory_xact_lock per company. **Client detail (NTN, CNIC, limits) readers = ['admin','owner','management','finance']** (fnb_manager excluded —
critic); the list for FINANCIALS_VIEWERS shows names/status only to fnb_manager. Views return capability flags (canApprove, canEdit, canIssueCards)
so the UI keeps no role lists.
**statements.ts:** issueStatementTx (lockAccountTx then claim unbilled charges with chargedAt ≤ periodTo end of PKT day **whose sale is BOOKED** —
the home drawer's 'shift.close:' entry posted, or 'order.complete:' posted for a non-till bill; others listed 'not billed yet' — critic), creates
ReceivableInvoice kind 'statement' (AR-ST-YYYY-NNNN, withNumberRetry, due = issue + termsDays, amount/tax net of refunds, customerAccountId,
periodFrom/To) with NO ledger entry; bulk issue (active company; returns created/skipped; 409 NOTHING_TO_BILL single); HTML render (bills with date,
order ref (orderRefOf), brand, card, reference, FiscalDocument.fiscalNumber (kind sale), previous balance, total due, due date, company bank details,
'Statement — not a tax invoice'); send via lib/notify sendEmail (the ONE platform SMTP; set a per-company reply-to = the company's first brand email,
documented) → 422 NO_EMAIL.
**writeOffs.ts:** request (WRITE_OFF_REQUESTERS admin/owner/management/finance; amount ≤ balanceOf; reason 10-500; 1-5 evidence files via
lib/evidenceFile decodeEvidenceFile(allowPdf, 3 MB); bodyLimit 20 MB; 409 WRITE_OFF_OPEN / WRITE_OFF_EXCEEDS_BALANCE; 400 EVIDENCE_REQUIRED /
BAD_FILE; kind invoice|statement only); list; evidence download (sendEvidence); **approve (ADMIN_ONLY) — separation of duties through
lib/separation-of-duties.ts assertNotSelfApproval (the CEO is exempt, decision 27); a request the CEO raises applies at once**; approve tx:
lockAccountTx (when customerAccountId) → lockInvoice → claim requested→approved → amount ≤ balance (409) → writtenOffCents += amount → post
'receivable.write_off:<id>' Dr 6160 (split per conceptId pro rata to a statement's charges' net; the invoice's conceptId otherwise) / Cr 1110 (full
amount incl. tax; pre-check 6160 → 422 ACCOUNT_NOT_FOUND, nothing saved; closed period → 422) → restatus → suspend the client (statusReason
'bad_debt_written_off'); reject (note); cancel; recover {amountCents ≤ amount − recovered, receivedAt, method, bankAccountId?, reference?}:
'receivable.write_off_recovery:<paymentId>' Dr 1110 / Cr 6160 + 'receivable.payment:<paymentId>' Dr moneyAccountCode / Cr 1110 in ONE tx with the
counters (409 OVER_RECOVERY). Audit in the invoice's company.
**workers/onAccountDaily.ts** (09:20 PKT per active company; wave Z starts it): one 'on_account_overdue' flag per overdue statement/invoice
(high after 30 days; resolved when balance ≤ 0); one 'on_account_unbilled' flag per client with booked charges > 35 days unbilled.

## Contracts you consume (already on disk when you start)

- w0: CustomerAccount* models, ReceivableWriteOff*, ReceivableInvoice/Payment columns, lib/onAccountCard.ts, lib/evidenceFile.ts, ACCT.BAD_DEBTS /
  ST_WITHHELD_BY_CUSTOMERS, assertTemplateAccounts. w1-taxcore: taxAuthorities (outputTaxCodeFor, authorityOfOutputCode). existing: assertNotSelfApproval.


## Contracts you expose (later waves code against these — keep the names and signatures)

```ts
// receivables/onAccount.ts
export const CHARGE_ERRORS: Record<string, { status: number; message: string }>
export function lockAccountTx(tx: Tx, accountId: string): Promise<CustomerAccount>
export function exposureOfTx(db: Db, accountId: string): Promise<{ unbilledCents: number; invoicesDueCents: number; exposureCents: number;
  overdue: { invoiceId: string; number: string; dueDate: Date; balanceCents: number } | null }>
export function assertChargeableTx(tx: Tx, account: CustomerAccount, a: { conceptId: string; billCents: number; reference?: string | null }): Promise<void>
export function recordChargeTx(tx: Tx, a: { tenantId: string; accountId: string; cardId: string | null; orderId: string; paymentId: string;
  conceptId: string; shiftId: string | null; amountCents: number; taxCents: number; reference: string | null; chargedById: string }): Promise<CustomerAccountCharge>
export function applyChargeRefundTx(tx: Tx, a: { orderId: string; refundPaymentId: string; amountCents: number }): Promise<void>
export function flagRevokedCardUse(tenantId: string, cardId: string): Promise<void>
// receivables/routes.ts (now exported)
export { lockInvoice, restatus, nextNumber, withNumberRetry, assertLiveInvoice, balanceOf, totalOf, statusFor, paymentKind }
```


## Tests

Your database: `servd_test_wb_w2_oa_recv`. Your Redis: `redis://127.0.0.1:6390/14`. Command (from `backend/`, your files only):

```
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w2_oa_recv REDIS_URL=redis://127.0.0.1:6390/14 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run tests/<file>.test.ts …
```

Two companies throughout: B → 404 on every A client/card/statement/write-off route; create binds to the active company; foreign brand in conceptIds
→ 422. `onAccountClients` (pending until the CEO approves; limit increase pending, decrease at once; reactivate admin-only; card code returned once,
DB holds hash + hint only, never in the audit; rotate kills the old code; fnb_manager can't read NTN/limits; capability flags). `onAccountExposure`
(exposure math incl. refunds; overdue after grace; assertChargeableTx refusals incl. two concurrent charges near the limit (one 409) via lockAccountTx;
applyChargeRefundTx on an unbilled and on a billed charge). `onAccountStatements` (claims exactly the BOOKED unbilled charges up to periodTo — an
open drawer's charge is listed 'not billed yet'; posts NO entry; payment Dr bank / Cr 1110; credit note → 409; void releases charges; bulk skips
empty clients; HTML lists fiscal numbers). `badDebtWriteOff` (evidence required; one open per invoice; non-admin approve → 403; finance requester
≠ CEO approver passes; a CEO-raised request applies at once; Dr 6160 / Cr 1110 in the invoice's company with the per-brand split for a statement;
status written_off, out of aging, client suspended; amount over balance after a later payment → 409; locked period → 422 nothing saved; recovery
reinstates + pays; reversing the recovery payment restores writtenOff and recoveredCents). `receivablesSalesTaxWithheld` (100,000 + 16,000 SRB
invoice, client withholds 3,200 → Dr 1335 / Cr 1110, balance down; over-cap → 409; reverse works; statement authority from its brands, two
authorities → 422; B → 404). receivablesCredit still passes with writtenOffCents in balanceOf.



## Rules (CLAUDE.md applies in full — these are the ones builders trip on)

1. **Ownership.** Edit ONLY the files listed under "You own". Shared/orchestrator files (schema.prisma, migrations, chartOfAccounts.ts,
   journal.ts, sourcePosting.ts, index.ts, moduleAccess.ts, workspaces.ts, approvals/types.ts, admin moduleCatalog.ts/appRoles.ts,
   tests/setup.ts) and every file another agent owns this wave: put the exact snippet in your report ("patch notes"). Read any file you like.
2. **Company separation from the first line.** Routes use `lib/tenantScope.ts` (`scopeTenantWhere(req,'read'|'write'|'create')`,
   `assertConceptOwned`, `conceptIdsInScope`, `activeTenantId`, `resolveTenantScope`). Resolve every client id (conceptId, locationId, shiftId,
   supplierId, bankAccountId, itemId, …) to its company first: foreign row → 404; cross-company attach on create → 422; an empty scope DENIES
   (`{ tenantId: { in: [] } }`), never `tenantFilter ?? undefined`. Orders have no tenantId: scope them through `concept`. Workers loop per
   company on `serviceClient`; route reads use the RLS client. Audit rows carry the DOCUMENT's tenantId.
3. **Money.** `postJournalEntry` with the SOURCE document's tenantId, inside the document's own transaction, idempotent `sourceType:sourceId`,
   debits == credits asserted before posting. User-entered money in a closed month → 422 PERIOD_LOCKED and nothing saved; system / approval
   / late postings use `lateDatingFor` (owner decision 6: post into the open month with a note naming the original date). A posting that can be
   refused outside a user request → `flagPostingFailed(sourceType, entity, sourceId)` and an exported re-post function (w4-integration wires
   REPOSTERS). BIGINT company money through lib/money.ts (`toCents`, `sumCents`, `assertMoneyFits`, `zMoneyCents`); INT4 per-ticket/per-unit/
   per-person/per-box money through `zInt4Cents` / `assertInt4Fits`. No bigint literals, `BigInt()` or bigint arithmetic in src; raw SQL sums
   cast `::bigint` then `toCents`; never select a widened table with `SELECT *` in raw SQL. Never `as never` / `as unknown` on a DB write.
   Want a clear 422 instead of `resolveAccountIds`' 500? Call `assertTemplateAccounts(db, tenantId, codes)` first.
4. **One source of truth.** Extend existing code; never a second resolver, rate table, engine, list or approval path. If you discover a duplicate
   the brief did not anticipate, STOP that part and report it (owner's standing rule).
5. **Locks.** Documented order: order → client account → invoice; `lockRaastTx` before the order lock; FIFO item locks in id order
   (`lockItemsTx`). Never hold a transaction across a network call, photo decode or `processPayment`.
6. **Tests.** Every route you add or change ships with a two-company test (company B gets 404 on A's rows; creates bind to the active company;
   cross-company ids → 422). Run from `backend/`:
   `DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w2_oa_recv REDIS_URL=redis://127.0.0.1:6390/14 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run <files>`
   (your own database and Redis index — never another agent's). Run ONLY your new test files and the existing suites listed in your brief (plus
   any other suite that covers code you changed — grep tests/ for the module). Never the whole suite, never `next build`, never a dev server,
   never production, never `git commit`. `npx tsc --noEmit -p .` in backend/ (and frontend/admin if you touched it): YOUR files must be clean;
   list errors in other agents' files without fixing them (they are being edited in parallel).
7. **Admin pages you own** (if any): tokens only (`var(--erp-*)`, `rgb(var(--x-rgb) / a)`, `color-mix(...)`, `s-badge-*`, `text-success`);
   purple = actions, green = state/good news, red = bad; no hard-coded colours, no emoji icons; money typed in rupees (convert to paisa);
   plain English; phone width; show the server's 403/404/409/422 messages; no local role lists (lib/roles.ts or server capability flags).


## Report format (your final message is the return value — no separate report file)

1. Files created / changed / deleted (paths).
2. Routes added/changed: method, path, guard (roles), module gate, scope mode, body, responses, error codes.
3. Postings: Dr/Cr, `sourceType:sourceId`, company source, date rule, where it runs (which transaction).
4. Contracts you EXPOSE (exact TypeScript signatures, file paths) — later waves code against these.
5. Tests: files written/updated, the exact command run, pass/fail counts; failures you believe belong to another agent's in-flight work.
6. `tsc` result for your files.
7. Patch notes: exact snippets for files you do not own (orchestrator or the next owner applies them).
8. Deviations from this brief and why; owner/accountant questions still open (with the default you built); anything still wrong.
