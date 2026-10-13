export const meta = {
  name: 'waveb-w0',
  description: 'Wave B wave 0: schema + migrations, chart + journal, admin shared, then shared backend libs and the test base',
  phases: [
    { title: 'Foundations', detail: 'schema + migrations, chart + journal, admin shared files (disjoint)' },
    { title: 'Libs', detail: 'shared backend libs and the tests base, on the generated client' },
  ],
}

const SP = '/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB'
const COMMON = `
You are one builder in WAVE 0 of "wave B" (finance gaps) of the servd monorepo at /home/user/servd. The plan documents are in ${SP}:
build-waves.md (read its "Wave 0" section), schema-merged.prisma.md, chart-merged.md, shared-files.md (section A = wave-0 items),
and /home/user/servd/.handoff/fixes/owner-decisions-20261013.md (BINDING owner decisions). Where the plan and the owner decisions disagree, the
owner decisions win; the PACKAGING RULE is the FINAL one in schema-merged.prisma.md decision P1 (order type + brand service vessel + "Box given").
Rules:
- Edit ONLY the files listed as yours below. Other wave-0 builders are editing other files at the same time; never touch, revert, format or
  "fix" a file you do not own, and never run git commands that change the tree (no git stash/checkout/reset/commit). Reading anything is fine.
- No production calls, no real messages, no builds (no next build / docker), no dev servers. You MAY run prisma CLI, npx tsc --noEmit, psql and vitest.
- Postgres is at 127.0.0.1:5432 (user postgres, no password); Redis for tests at 127.0.0.1:6390. Use ONLY the database(s) and Redis index named
  for you. Test command (from backend/): DATABASE_URL=postgresql://postgres@127.0.0.1:5432/<db> REDIS_URL=redis://127.0.0.1:6390/<idx>
  JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only
  NODE_ENV=test npx vitest run <files>
- Company separation (CLAUDE.md standing rule) applies to every line. Match the surrounding code's style and comment density.
- Your final answer is a JSON object (the schema is enforced): what you did, the files you changed, any deviation from the plan with the reason,
  and problems the orchestrator must handle (e.g. tsc errors that come from another builder's files).
`
const RESULT = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    deviations: { type: 'array', items: { type: 'string' } },
    problems: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'filesChanged', 'deviations', 'problems'],
}

const SCHEMA = COMMON + `
YOUR JOB (id w0-schema): the Prisma schema and the two migrations — exactly schema-merged.prisma.md (read ALL of it, sections 0-8).
You own: backend/prisma/schema.prisma, backend/prisma/migrations/20261014085900_finance_wave_b_enums/migration.sql (new),
backend/prisma/migrations/20261014090000_finance_wave_b/migration.sql (new). Database: servd_test_wb_w0_dry (scratch; you may drop/recreate it).
Steps:
1. Save the current schema first: \`git show HEAD:backend/prisma/schema.prisma > ${SP}/w0/schema.before.prisma\` (mkdir -p ${SP}/w0).
2. Edit schema.prisma per §3 (every model change incl. §3.39 OrderItem serviceVessel/boxGiven and §3.1 Concept.serviceVessel), comment the SQL-only
   partial uniques (§5) and CHECKs (§6) on their models the way the file already does for older ones. Every company-level money column is BigInt
   (BOOKS-06); per-ticket stays Int. Every new company table has tenantId (indexed) and per-company uniques.
3. Enum migration (§1): ALTER TYPE … ADD VALUE IF NOT EXISTS only; nothing in either migration may USE a value added there.
4. Main migration: header per §2 (what it does, SET lock_timeout = '15s', and the P3009 runbook: \`prisma migrate resolve --rolled-back
   20261014090000_finance_wave_b\` in the api image before redeploying — see 20261013150000_finance_gaps_wave_a and 20261012140000_money_bigint for
   the house style). DDL: generate with \`npx prisma migrate diff --from-schema-datamodel ${SP}/w0/schema.before.prisma --to-schema-datamodel
   prisma/schema.prisma --script\` and move any enum ADD VALUE lines out into the enum migration; then the backfills of §4 IN ORDER (each idempotent,
   guarded by its WHERE), the partial / expression uniques of §5, the CHECKs of §6, RLS of §7 (the guarded DO-block pattern of the wave-A migration).
   Every statement must be safe on a production database that has real rows (NOT NULL columns get defaults or a backfill before SET NOT NULL).
5. \`npx prisma validate\` and \`npx prisma generate\` (from backend/).
6. DRY RUN: drop+create servd_test_wb_w0_dry; \`npx prisma db push --skip-generate --schema ${SP}/w0/schema.before.prisma\` against it; insert a few
   representative rows into the tables the migration touches (at least: tenants, concepts incl. slugs 'stackd' and 'simmer', accounts, orders +
   order_items, recipes + recipe_ingredients with a packaging-category inventory item, supplier bills, fixed assets, petty cash boxes, cash vouchers
   — whatever §4's backfills read); apply the enum file then the main file with \`psql -v ON_ERROR_STOP=1 -f\`; then
   \`npx prisma migrate diff --from-url postgresql://postgres@127.0.0.1:5432/servd_test_wb_w0_dry --to-schema-datamodel prisma/schema.prisma --script\`
   must contain nothing except statements about the SQL-only objects (list them in your result). Run the §4 backfill block a second time and confirm
   it changes 0 rows (idempotent). Check the stackd concept got serviceVessel 'packaging' and others 'plate'.
7. Re-run \`npx prisma generate\` last so the client on disk matches. Do NOT run tsc over the whole backend as a gate (other builders' files are in
   flux) — but do report any tsc errors that point at schema field names you changed or removed (\`npx tsc --noEmit -p .\` from backend/ is fine to read).
`

const CHART = COMMON + `
YOUR JOB (id w0-chart): the chart of accounts and the journal constants — exactly chart-merged.md (all sections) plus shared-files.md §A
"backend/src/lib/chartOfAccounts.ts" and "backend/src/modules/accounting/journal.ts".
You own ONLY: backend/src/lib/chartOfAccounts.ts and backend/src/modules/accounting/journal.ts.
- chartOfAccounts.ts: every new code / rename, the reserved-range header, REQUIRED merge, the template field \`controlledBy\` (copied onto rows
  ensureChartOfAccounts CREATES; existing rows get it from the migration backfill), \`assertTemplateAccounts\`, \`REGISTER_CONTROLLED_CODES\`.
  ensureChartOfAccounts must still only ADD missing codes (operator edits survive).
- journal.ts: ACCT additions (all areas), TILL_CLEARING_CODES, ON_ACCOUNT_MEMO, CONTROLLED_PREFIX, the controlled-account rule (one mechanism incl.
  the 'fixed_asset' override) with the \`controlledOverride\` input on postJournalEntry, \`lateDatingFor\`. Nothing else in journal.ts.
- The schema builder is adding Account.controlledBy (and other columns) to schema.prisma right now and will run prisma generate; tsc errors that
  only say a Prisma field does not exist yet are expected while it runs — re-check later with \`npx tsc --noEmit -p .\` from backend/ and report what
  remains in YOUR files. Do not edit any other file to make tsc pass; list needed follow-ups in problems.
- Run the existing chart/journal suites you find relevant (grep backend/tests for chartOfAccounts / ensureChartOfAccounts / postJournalEntry,
  pick at most 4) on database servd_test_wb_w0_chart, Redis index 29, after the generated client has controlledBy; report results (failures that
  come from other wave-0 files in flux are problems, not yours to fix).
`

const ADMIN = COMMON + `
YOUR JOB (id w0-admin): the admin shared files and the shared order type — shared-files.md §A items:
frontend/admin/src/lib/appRoles.ts, frontend/admin/src/lib/moduleCatalog.ts, frontend/admin/next.config.js, frontend/admin/src/app/exceptions/page.tsx,
packages/types/src/order.ts (+ order.d.ts if it exists). You own ONLY those files.
- appRoles.ts: ModuleId += 'food_cost', 'emergency_overrides' with MODULES entries as described.
- moduleCatalog.ts: every FC/FA/PP/OA/CA/DL change and the MODULE_GAPS rewrites listed in shared-files.md §A (no ModulePage.roles; no emoji).
  The recipes gap text must follow the FINAL packaging rule: every dish has a Packaging section; it counts on takeaway/delivery, on every order of
  a brand whose primary service vessel is packaging, and on dine-in only when staff tap "Box given". Cash vouchers become "Cash requests".
- next.config.js: the permanent redirect /accounting/food-cost → /reports/food-cost (keep every existing redirect).
- exceptions/page.tsx: plain-English labels for every new ExceptionKind listed in shared-files.md §A "backend/src/lib/exceptions.ts".
- packages/types order fields as listed.
- Then run \`npx tsc --noEmit -p .\` in frontend/admin and make YOUR files clean (errors elsewhere: report them). Tokens only, never a hard-coded colour.
`

const LIBS = COMMON + `
YOUR JOB (id w0-libs): the shared backend libraries of wave 0 — every shared-files.md §A item marked w0 EXCEPT schema/migrations, chartOfAccounts.ts,
journal.ts, tests/setup.ts, moneyBigint.test.ts, packages/types and the frontend files (other builders did those; schema + chart + journal are already
on disk and the Prisma client is generated). Read the CURRENT journal.ts for the ACCT names.
You own: backend/src/modules/accounting/sourcePosting.ts, backend/src/lib/bankAccounts.ts (ledgerBalancesByCode asOf only),
backend/src/lib/exceptions.ts, backend/src/lib/inventoryClass.ts (new), backend/src/lib/savepoint.ts (new) + the withSavepoint import swap in
backend/src/modules/orders/service.ts (that swap ONLY), backend/src/lib/evidenceFile.ts (new) + the import swap in
backend/src/modules/trustops/cashVouchers.ts (that swap ONLY), backend/src/lib/onAccountCard.ts (new),
backend/src/modules/accounting/closeCheckTypes.ts (new), backend/src/modules/accounting/fiscalYear.ts (new, pure part only),
backend/src/lib/tenders.ts, backend/src/modules/approvals/types.ts, backend/src/lib/moduleAccess.ts, backend/src/lib/workspaces.ts,
backend/src/modules/reconciliation/routes.ts + the three STUB child plugin files it registers (cardPayoutRoutes.ts, codRoutes.ts,
pettyCashBackfillRoutes.ts, each \`export default async function plugin(){}\` with a header naming its wave-B owner), and
backend/src/modules/reconciliation/backfillOrders.ts (exports only, no behaviour change).
Follow shared-files.md §A for each exactly (GATED_PREFIXES insertion order matters; emergency_overrides defaults: boh_management, fnb_manager,
foh_management, filtered OUT of OWNER_MODULES and MANAGER_MODULES; food_cost defaults: fnb_manager, boh_management, finance; MODULE_GRANTS += both;
workspaces: food_cost in Finance → reports, a new Operations section 'emergency' with emergency_overrides).
Then: \`npx tsc --noEmit -p .\` from backend/ — make every error in YOUR files go away (report errors in other files). Run the module-access and
workspace suites (grep backend/tests for MODULE_GRANTS, GATED_PREFIXES, workspaces, moduleAccess — at most 6 files) and the cash-voucher suite on
database servd_test_wb_w0_libs, Redis index 27; fix failures caused by your changes; a test that asserted the OLD module list is updated to the new
defaults (that test file is then yours — say which).
`

const TESTS = COMMON + `
YOUR JOB (id w0-tests): the test base — shared-files.md §A "backend/tests/setup.ts" and "backend/tests/moneyBigint.test.ts".
You own ONLY backend/tests/setup.ts and backend/tests/moneyBigint.test.ts. Schema, migrations, chart and journal are on disk; the client is generated.
- setup.ts: seed every template code (use the CHART_OF_ACCOUNTS list / ensureChartOfAccounts for the test companies — keep what existing tests rely
  on), and after \`db push\` apply the SQL-only objects of the new main migration (§5 partial uniques and §6 CHECKs of schema-merged.prisma.md) read
  straight from backend/prisma/migrations/20261014090000_finance_wave_b/migration.sql, the way applyRawSqlObjects already reads older ones (one copy
  of the SQL; idempotent; extract by markers you add NOTHING to — if the migration lacks clean markers, report it as a problem instead of editing it).
- moneyBigint.test.ts: EXPECTED_BIGINT_FIELDS += the new BigInt fields of schema-merged.prisma.md §3.38, with the expected count taken from the
  generated DMMF (the test must pass against the generated client).
- Run tests/moneyBigint.test.ts plus 3 existing posting suites (e.g. tests that use postJournalEntry / ensureChartOfAccounts) on database
  servd_test_wb_w0_tests, Redis index 28. Failures caused by the setup change are yours; failures from other wave-0 files are problems.
`

phase('Foundations')
const first = await parallel([
  () => agent(SCHEMA, { label: 'w0-schema', phase: 'Foundations', schema: RESULT, model: 'opus' }),
  () => agent(CHART, { label: 'w0-chart', phase: 'Foundations', schema: RESULT, model: 'opus' }),
  () => agent(ADMIN, { label: 'w0-admin', phase: 'Foundations', schema: RESULT, model: 'opus' }),
])
const schemaRes = first[0]
if (!schemaRes) {
  return { first, stopped: 'w0-schema did not finish; libs and tests not started' }
}
phase('Libs')
const second = await parallel([
  () => agent(LIBS + '\nSchema builder report:\n' + JSON.stringify(schemaRes).slice(0, 4000) + '\nChart builder report:\n' + JSON.stringify(first[1]).slice(0, 3000),
    { label: 'w0-libs', phase: 'Libs', schema: RESULT, model: 'opus' }),
  () => agent(TESTS + '\nSchema builder report:\n' + JSON.stringify(schemaRes).slice(0, 4000),
    { label: 'w0-tests', phase: 'Libs', schema: RESULT, model: 'opus' }),
])
return { schema: schemaRes, chart: first[1], admin: first[2], libs: second[0], tests: second[1] }
