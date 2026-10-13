export const meta = {
  name: 'finance-gaps-verify',
  description: 'Adversarially verify the 18 finance-gap findings (grouped by domain) and design each fix with owner questions + defaults',
  phases: [
    { title: 'Verify', detail: 'one skeptic per domain group: refute or confirm each finding, then design the fix' },
  ],
}

const RULES = `Repo /home/user/servd (Fastify+Prisma backend in backend/, Next.js admin in frontend/admin/). READ-ONLY: do not edit/create/delete files, no builds, tests, dev servers or migrations, never call production. CLAUDE.md rules apply (company separation; postJournalEntry requires tenantId from the source document; period locks; BIGINT money via lib/money.ts; flag duplicates — extend existing code, never a second path).

The owner wants "no known gaps in the finance section". An auditor produced findings; some may be wrong, stale or overstated. For EACH finding in your group:
1. Open every cited file:line and the surrounding code, and grep widely for the capability elsewhere (other modules, workers, admin pages, migrations, tests). Try hard to REFUTE it. Verdict: confirmed | partly (say exactly which part is true) | refuted (cite where it is handled).
2. If confirmed/partly: the concrete fix that EXTENDS existing code — files to change, Dr/Cr lines with account codes per company, idempotency key, period-lock behaviour, schema change (tenantId, BIGINT for company-level money), admin UI change, tests (incl. two-company). Size: S (<1h agent), M (half day), L (day+).
3. Whether the fix needs an owner/accountant decision. If so, ONE crisp question in plain business English (the owner is a restaurant-group CEO, not an accountant; the accountant is a CA), 2-4 options, and your recommended default that follows Pakistani practice (FBR, SRB/PRA, EOBI, SESSI/PESSI, ITO 2001) so the build can start on the default. If no decision is needed, say so — the fix just gets built.
Be precise and terse. Evidence beats prose.`

const GROUPS = [
  { key: 'cash', findings: `
PETTY CASH (known, confirm + design): backend/src/modules/trustops/routes.ts POST /petty-cash/movements (topup/spend/reconcile/transfer) and /petty-cash/boxes/:id/reconcile post NOTHING to the ledger except a spend that pays a supplier bill (createPaymentTx → Dr 2010 / Cr 1010). Top-ups never debit 1010, so 1010 goes negative. Box opening float (floatCents on create) never booked. Spend category is free text (admin finance/petty-cash/page.tsx). Design: topup Dr 1010 / Cr source (bank 102x? till drawer 1015? safe?), spend Dr 6xxx (accounting/expenseCategories.ts PAYOUT_CATEGORIES / expense account picker) / Cr 1010, reconcile variance 8010, transfer between boxes (same company no entry; cross-company refuse), opening float, and a BACKFILL of historic movements. NOTE: a parallel agent is right now extracting recordPettyCashSpendTx into trustops/routes.ts and building backend/src/modules/trustops/cashVouchers.ts (cash vouchers: draft→hod_signed→approved→disbursed; disbursed voucher = one petty-cash spend). Design posting so it lives in the shared spend helper. Cash vouchers for the DIRECTOR's own cash may be an expense, an advance to settle later (1350 Staff Loans & Advances?) or owner's drawings (3030) — include that question.
FINDING 1 — Unpaid cash-on-delivery stays booked as cash: orderPosting.ts:379-388 debits 1010 at delivery completion; orders/routes.ts:325-364 cod-unpaid only records a customer strike; sale, tax and 1010 stay; order sits on /pos/cod-due forever (pos/routes.ts:307-325). Also check how rider cash collection is reconciled (rider module, dispatch, riders) — is COD cash ever handed in / booked from the rider?` },
  { key: 'payroll', findings: `
FINDING 2 — Full & final settlements never posted: hr/routes.ts:295-299 computes F&F net; hr/service.ts:523-541 excludes the leaver from payroll; hr/ledger.ts has no F&F posting — last salary, overtime, leave encashment, gratuity never expensed, cash out never booked, 1350 loan never cleared.
FINDING 11 — Payroll stand-in accounts: EOBI/SESSI → 2090 Accrued Expenses (hr/ledger.ts:24); salary income tax → 2040 (chart says supplier WHT, chartOfAccounts.ts:62); no remittance posting when EOBI/SESSI/salary tax is paid to the authorities.
FINDING 9 (payroll part) — payroll paid from 1020 regardless of bank (hr/routes.ts:1541-1545); staff loans bank-only (hr/ledger.ts:155); employees have a payment method (cash/bank) but one account is credited.` },
  { key: 'intercompany_period', findings: `
FINDING 3 — Inter-company: positions/contributions.ts:29-31 claims a contribution "moves money on BOTH sides' books" but nothing posts; chart has no due-to/due-from; head office (D1) not built. Unverified: whether old cross-company loyalty/wallet balances (.handoff/fixreports/ledger.md:34, .handoff/fixes/NEEDS.md:55-57) were cleaned up.
FINDING 12 — Rent advances from CapEx → 1310 Prepaid (financePlanning/capexPosting.ts:5-6, 32-41) never amortised; refundable security deposits also in 1310.
FINDING 16 — Period close checks only Raast (accounting/routes.ts:779-835): no check that depreciation ran, payroll locked, tills closed, posting failures cleared; no year-end close; balance sheet shows all profit since day one as current earnings (accounting reports.ts:216-218). Pakistani fiscal year is 1 July–30 June for most companies.` },
  { key: 'purchases_stock', findings: `
FINDING 4 — accounting/supplierPosting.ts:639-646 books every bill to 1210 Inventory – Food; stale "schema TODO" — InventoryItem.category exists (schema.prisma ~1979-1981) with 'packaging' but no 'beverage'; non-stock bill lines (cleaning, services, equipment up to INT4 per line) also → 1210 (procurement/service.ts:31-36, 404-409); food cost always 5010/1210 (orderPosting.ts:450-453) so 1220/1230/5020/5030 never used; menu items without a recipe book no COGS (orderPosting.ts:276-277).
FINDING 15 — Goods received not invoiced: procurement/receiving.ts raises stock (incl. market runs without a PO) but nothing posts until the bill — month-end stock and liabilities understated.
FINDING 17b — Stock lost in transit between locations never booked (stockTransfers/routes.ts:145-157), only surfaces as count variance.` },
  { key: 'tax', findings: `
FINDING 5 — Input tax always 1320 (supplierPosting.ts:656-658), procurement has no authority field; 1321-1324 never posted; sales tax return always shows provincial input 0 (accounting/salesTaxReturn.ts:77-80, 495-498) and its note at 477 tells users to tag provincial input the bill form cannot capture; OpEx payments post gross with no input tax and no withholding (opex/posting.ts header).
FINDING 6 — Sales-tax return output = net movement on 2030-2034 for the period (salesTaxReturn.ts:48-66, 396-400) so a tax payment / adjusting JE dated in the month reduces "output tax"; no first-class "pay sales tax" posting. Unverified: whether the one-off SRB reclass out of 2030 (salesTaxReturn.ts:468-474) was ever posted.
FINDING 10 — Delivery fee not stored on the order (lib/pricing.ts:202-215); sale posting puts it in brand food revenue (orderPosting.ts:337-346); tax return counts it as taxable (salesTaxReturn.ts:411-441) though no tax charged.
FINDING 17c — Reservation no-show capture posts Dr 1020 / Cr 4100 Service Charges with no tax (reservations/routes.ts:1717-1723); reservation deposits have no admin screen.` },
  { key: 'giftcards_failures', findings: `
FINDING 7 — Gift cards: void posts nothing (2080 keeps the value; any cash refund unbooked) giftCards/routes.ts:234-257; expiry only flips status (giftCards/service.ts:113-115), no breakage income account; bank-transfer sale debits 1030 (~routes.ts:161); no complimentary/promotional issue (tender only cash/card/bank, routes.ts:121); sale JE failure swallowed (routes.ts:167).
FINDING 8 — Postings that fail silently (log only, no exception flag, no re-post): gift-card sale (giftCards/routes.ts:167), deposit drops (trustops/routes.ts:543-545), manual waste (inventory/routes.ts:589-592), stocktake variance (crosschecks/routes.ts:345-357, comment says "can be re-run" but no route). reconciliation/backfillOrders.ts:1-21 backfills only orders, loyalty, refunds, till closes. Void-waste failures ARE flagged but the flag text points at a backfill that cannot re-post them (accounting/journal.ts:352). Check the posting_failed exception mechanism (loyalty/service.ts:223 BOOKS-R2-01 follow-up) and whether it can be reused.` },
  { key: 'banking_ar', findings: `
FINDING 9 (non-payroll) — Payments hard-coded to 1020/1010 regardless of which bank: supplier payments (supplierPosting.ts:839-842; SupplierPayment has no bank account field), receivables receipts (receivables/routes.ts:27), wallet top-ups, fixed-asset purchases, reservation deposits. Bank deposits and OpEx already use the chosen bank (BankAccount model with ledger code). Wrong as soon as a second bank (1021+) exists.
FINDING 13 — Card MDR never accrued; nothing posts to 6080; 1030 cleared only by manual settlement split (reconciliation/service.ts:290-300); net settlements never auto-match. Check connectors/terminal and the bank-statement matcher.
FINDING 14 — No supplier credit notes/returns (bill only voidable whole); AR credit notes "not built yet" (receivables/routes.ts:229-231, admin accounting/receivables/page.tsx:6); no bad-debt write-off; corporate client paying net of WHT leaves invoice partial forever (1330 never posted); no on-account tender at the till.` },
  { key: 'low_cosmetic', findings: `
FINDING 17d — OpEx categories map to 6xxx by keyword on the NAME (accounting/expenseCategories.ts:8-11); OpexCategory has no expenseAccountCode column. A category the map can't tell is refused (opex/posting.ts:76) — check whether that blocks real payments and whether a column + picker is the fix.
FINDING 18 — cosmetic/housekeeping: stale comments giftCards/routes.ts:5-6 and supplierPosting.ts:639-640; no-op noteItemVoid orderPosting.ts:1054-1060 (check callers — is a single-item KDS void meant to derecognise revenue/COGS and silently doesn't?); "Purchase order feature coming soon" button at frontend/admin/src/app/inventory/page.tsx:604 (does a PO feature exist elsewhere — procurement? then the button is a dead duplicate entry point); unused invoice_counters table (schema.prisma ~2833) — confirm no reader/writer remains.
ALSO sweep frontend/admin/src/app/{finance,accounting,reconciliation,gift-cards,procurement}/** and backend finance modules for any other "coming soon", "not built", "not yet", "TODO", disabled finance buttons or hard-coded figures that the auditor missed, and report them as extra findings.` },
]

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          finding: { type: 'string', description: 'finding number/name' },
          verdict: { type: 'string', enum: ['confirmed', 'partly', 'refuted'] },
          facts: { type: 'string', description: 'what is actually true, with file:line' },
          fix: { type: 'string', description: 'concrete fix extending existing code: files, Dr/Cr per company, schema, UI, tests' },
          size: { type: 'string', enum: ['S', 'M', 'L', 'n/a'] },
          needs_decision: { type: 'boolean' },
          question: { type: 'string', description: 'plain-English owner/accountant question, or empty' },
          options: { type: 'array', items: { type: 'string' } },
          recommended_default: { type: 'string' },
          for_accountant: { type: 'boolean', description: 'true if the CA, not the CEO, should answer' },
        },
        required: ['finding', 'verdict', 'facts', 'fix', 'size', 'needs_decision', 'question', 'options', 'recommended_default', 'for_accountant'],
      },
    },
    extra_findings: { type: 'array', items: { type: 'string' }, description: 'new gaps discovered while verifying, with file:line' },
  },
  required: ['items', 'extra_findings'],
}

const out = await parallel(GROUPS.map((g) => () =>
  agent(`${RULES}

GROUP: ${g.key}
${g.findings}`, { label: `verify:${g.key}`, phase: 'Verify', schema: SCHEMA }).then((r) => (r ? { group: g.key, ...r } : null))))

return out.filter(Boolean)
