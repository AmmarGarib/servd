export const meta = {
  name: 'waveA-review',
  description: 'Adversarial review of the finance gaps wave A changes, per group, with an independent refute pass per finding',
  phases: [
    { title: 'Review', detail: 'one reviewer per group hunts real bugs in its diff' },
    { title: 'Verify', detail: 'a skeptic tries to refute each finding' },
  ],
}

const COMMON = `Repo /home/user/servd (uncommitted working tree vs HEAD = the "wave A" finance changes). CLAUDE.md applies. READ-ONLY review:
do not edit files, do not commit, do not run builds/dev servers, never call production. You MAY run ONE targeted vitest file if it settles a
question, from backend/ with: DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wa_<db> REDIS_URL=redis://127.0.0.1:6390/<idx>
JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only NODE_ENV=test npx vitest run <file>
(a full suite is already running elsewhere — never run the whole suite).
Use \`git diff HEAD -- <paths>\` and \`git status\` to see the change. Shared helpers added by the orchestrator: backend/src/lib/bankAccounts.ts
(moneyAccountCode, strict bankLedgerCode), migration backend/prisma/migrations/20261013150000_finance_gaps_wave_a, admin
components/finance/BankAccountSelect.tsx.
Hunt for REAL defects only, each with file:line and a concrete failing scenario:
- money: unbalanced or double postings, wrong account/sign, wrong company (tenant must come from the source document), posting outside the
  document's transaction where a closed period should refuse, idempotency keys that collide or don't dedupe, amounts mixing paisa/rupees,
  BIGINT vs INT4 (lib/money.ts rules), status/balance formulas that disagree between list, detail, aging and ledger;
- company separation: foreign rows not 404, cross-company attach not 422, scope that fails open, a client-supplied id trusted;
- concurrency: check-then-write races on money (two requests both pass a check);
- permissions: who can call it vs who should (CLAUDE.md role rules, GATED_PREFIXES module gates);
- regressions: existing callers broken by a changed signature/response shape (grep callers in backend AND frontend/admin AND tablet);
- admin UI: wrong field names vs the API, money units, broken flows.
Do NOT report style, naming, or things already listed as pending owner decisions (C1/C2/C5 petty cash posting, G1-G15, K2, F*).`

const NOTE = `

IMPORTANT: the wave A change is now COMMITTED as 405ce1c (parent 1ce5781). Read the change with \`git diff 1ce5781 405ce1c -- <paths>\`
plus \`git diff HEAD -- <paths>\` for anything still uncommitted (not \`git diff HEAD\` alone, which is now empty).`

const GROUPS = [
  { key: 'ap', db: 'ap', idx: 20, paths: 'backend/src/modules/accounting/supplierPosting.ts backend/src/modules/procurement frontend/admin/src/app/procurement frontend/admin/src/components/finance/ApAging.tsx backend/tests/supplierCreditNotes.test.ts backend/tests/supplierPaymentsBank.test.ts',
    what: 'Supplier payments to the bank used (moneyAccountCode), payment unapply/void, supplier credit notes/returns (SupplierBill kind credit_note + SupplierCreditApplication, postSupplierCreditNote incl. WHT share, stock return, 5060 true-up, void), billDueCents = total - wht - paid - credited everywhere, Reorder tab fix. Also petty cash / till bill pre-checks now refuse credit notes (trustops/routes.ts, pos/service.ts).' },
  { key: 'ar', db: 'ar', idx: 21, paths: 'backend/src/modules/receivables backend/src/modules/wallet frontend/admin/src/app/accounting/receivables frontend/admin/src/app/crm/page.tsx backend/tests/receivablesCredit.test.ts backend/tests/resimWallet.test.ts',
    what: 'Receivable receipts to the bank used, credit notes (allowing a credit balance), refunds of credit balance, receipt reversal (bounced cheque), customer income-tax WHT (Dr 1330), status credited, brand tax rates instead of 15%, wallet top-up bank.' },
  { key: 'hr', db: 'hr', idx: 22, paths: 'backend/src/modules/hr frontend/admin/src/app/hr frontend/admin/src/components/hr backend/tests/hrFinalSettlementLedger.test.ts',
    what: 'F&F accrual at approval (wage accounts, 2090/2040 statutory, 1350 loan recovery, 2020 net), F&F payment route, cancel reversal, backfill, double-pay fix (payroll excludes settled leavers), statutory deductions in F&F, payroll paid with bank/cash split and paidOn, loan disbursement source.' },
  { key: 'gc', db: 'gc', idx: 23, paths: 'backend/src/modules/giftCards backend/src/workers/giftCardExpiry.ts backend/src/modules/accounting/orderPosting.ts backend/src/lib/chartOfAccounts.ts frontend/admin/src/app/gift-cards backend/tests/giftCardLedger.test.ts',
    what: 'Gift card issue in one tx with its entry (cash 1010 / card 1030 / bank / promotional 6060), issue restricted to managers+finance, void dispositions refund/payment_not_received/promo forfeit, book-issue for old cards, expiry worker (status only), refund re-credit never reactivates a voided/expired card, 2080 required, reconcile endpoint, paginated list (response shape changed to {items,nextCursor,total}).' },
  { key: 'tax', db: 'tax', idx: 24, paths: 'backend/src/modules/accounting/salesTaxReturn.ts backend/src/modules/accounting/taxPayments.ts backend/src/modules/accounting/routes.ts frontend/admin/src/app/accounting/sales-tax-return backend/tests/taxPayments.test.ts',
    what: 'SalesTaxPayment record/link/void/reclass, return output excludes payment/linked entries, per-authority paid + balances, inactive brands kept, zero-rated/exempt lines at 0% with stored tax spread over taxed lines, reclass reflected in by-rate.' },
  { key: 'opex', db: 'opex', idx: 25, paths: 'backend/src/modules/opex backend/src/modules/accounting/expenseCategories.ts backend/src/modules/financePlanning frontend/admin/src/app/finance/opex frontend/admin/src/app/finance/capex/page.tsx backend/tests/opexAccounts.test.ts',
    what: 'OpexCategory.expenseAccountCode + picker + boot backfill, name map fixes (utilities → 6020 also at the till payout list, new water/gas payout keys), posting order, OpEx card treated as bank, payment corrections, post-unposted per-payment tx, CapEx instalment bankAccountId.' },
  { key: 'pf', db: 'pf', idx: 26, paths: 'backend/src/modules/accounting/journal.ts backend/src/modules/accounting/depositPosting.ts backend/src/modules/crosschecks backend/src/modules/inventory backend/src/modules/reconciliation/backfillOrders.ts backend/src/modules/reconciliation/routes.ts backend/src/modules/pos/service.ts backend/src/modules/orders/service.ts backend/src/modules/paymentGateways/keenuSettle.ts frontend/admin/src/app/reconciliation/BackfillUnposted.tsx backend/tests/postingFailures.test.ts',
    what: 'flagPostingFailed at every refused posting (waste, count, void waste, cancel unwind, card failure, deposit drop), re-posters registry in backfill step 4 (incl. reservation.deposit_capture added by the orchestrator), posting into the current month with a memo when the original month is locked, sweep for unflagged misses that raises flags rather than posting.' },
  { key: 'cc', db: 'cc', idx: 27, paths: 'backend/src/modules/trustops backend/src/lib/strikes.ts backend/src/modules/orders/routes.ts backend/src/modules/pos/routes.ts backend/src/modules/reports/service.ts backend/src/modules/reconciliation/service.ts backend/src/modules/reservations frontend/admin/src/app/finance/petty-cash frontend/admin/src/app/finance/deposit-drops frontend/admin/src/app/pos/shift/DrawerPanels.tsx backend/tests/cashControls.test.ts',
    what: 'Petty cash movements lockdown (topup|spend only, custodian/keeper top-ups, INT4 bounds), transfers, box PATCH (limit raise needs PIN), opening float movement, one movement writer; deposit drops via moneyAccountCode + awaited posting + flag; cod-unpaid managers-only + checks + strike dedupe; cod-due rider/age/overdue; salesByTender COD split; reservation deposit release/capture (Dr 1030); bank import scope. Plus cash vouchers (trustops/cashVouchers.ts, committed earlier) must still work with the new pettyCash.ts helpers.' },
]

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          scenario: { type: 'string', description: 'concrete inputs/state -> wrong result' },
          fix: { type: 'string' },
        },
        required: ['title', 'file', 'line', 'severity', 'scenario', 'fix'],
      },
    },
  },
  required: ['findings'],
}
const VERDICT = {
  type: 'object',
  properties: {
    real: { type: 'boolean' },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    reasoning: { type: 'string' },
    fix: { type: 'string', description: 'the minimal correct fix if real' },
  },
  required: ['real', 'severity', 'reasoning', 'fix'],
}

const results = await pipeline(
  GROUPS,
  (g) => agent(`${COMMON}${g.key === 'ap' || g.key === 'ar' ? '' : NOTE}

GROUP ${g.key}: ${g.what}
Files: ${g.paths}
Test DB if you need one test run: servd_test_wa_${g.db}, Redis index ${g.idx}.
Return every real defect you can substantiate (none is a fine answer).`, { label: `review:${g.key}`, phase: 'Review', schema: FINDINGS }),
  (r, g) => parallel((r?.findings ?? []).map((f) => () =>
    agent(`${COMMON}${NOTE}

A reviewer claims this defect in group ${g.key} (${g.what}).
CLAIM: ${f.title}
WHERE: ${f.file}:${f.line}
SCENARIO: ${f.scenario}
SUGGESTED FIX: ${f.fix}

Try hard to REFUTE it: read the code paths end to end (callers, guards, transactions, tests). real=true only if the scenario really
produces a wrong result in the current working tree. If real, give the minimal correct fix and a calibrated severity.`, { label: `verify:${g.key}:${f.title.slice(0, 40)}`, phase: 'Verify', schema: VERDICT })
      .then((v) => ({ group: g.key, ...f, verdict: v })))),
)

const all = results.flat().filter(Boolean)
return { confirmed: all.filter((x) => x.verdict && x.verdict.real), refuted: all.filter((x) => x.verdict && !x.verdict.real).map((x) => ({ group: x.group, title: x.title, why: x.verdict.reasoning.slice(0, 300) })) }
