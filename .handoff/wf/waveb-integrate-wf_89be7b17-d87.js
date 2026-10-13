export const meta = {
  name: 'waveB-integrate',
  description: 'Merge the 7 Wave B designs into one schema migration, one chart, shared-file ownership and conflict-free build waves; then verify the merge',
  phases: [
    { title: 'Merge', detail: 'integration architect writes the merged plan files' },
    { title: 'Verify', detail: 'a second agent checks nothing was lost or collides' },
  ],
}
const SP = '/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad'
const W = SP + '/waveB'
const CTX = `Repo /home/user/servd. Do NOT edit any repo file; write ONLY the output files named below under ${W}/. No builds, no tests, no dev servers, never call production.
Inputs: the 7 area designs + critic reports in ${W}/assets_foodcost.json, ${W}/tax_people.json, ${W}/cash_delivery_onaccount.json (each {plans:{area:plan}, critics}); binding owner decisions /home/user/servd/.handoff/fixes/owner-decisions-20261013.md (the LAST bullets win, incl. the final packaging rule); accountant defaults: the QS array in ${SP}/hasnain-questions.html (H1-H30, option 'def'); CLAUDE.md (company separation, money, ledger, fiscal rules); the current backend/prisma/schema.prisma, backend/src/lib/chartOfAccounts.ts, backend/src/modules/accounting/journal.ts ACCT.`

const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    files_written: { type: 'array', items: { type: 'string' } },
    chart_conflicts_resolved: { type: 'array', items: { type: 'string' } },
    schema_conflicts_resolved: { type: 'array', items: { type: 'string' } },
    critic_corrections_applied: { type: 'array', items: { type: 'string' } },
    waves: { type: 'array', items: { type: 'string' }, description: 'wave name: agents in it (parallel) — short' },
    open_risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['files_written', 'chart_conflicts_resolved', 'schema_conflicts_resolved', 'critic_corrections_applied', 'waves', 'open_risks'],
}
const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'string' }, description: 'each: what is wrong in the merged files + the exact fix' },
    fixed_in_place: { type: 'array', items: { type: 'string' }, description: 'problems you corrected directly in the output files' },
  },
  required: ['ok', 'problems', 'fixed_in_place'],
}

phase('Merge')
const merged = await agent(`${CTX}

You are the integration architect for "Wave B" (7 areas: assets, foodcost, tax, people, cash, delivery, onaccount). Produce these files:

1. ${W}/schema-merged.prisma.md — the COMPLETE set of Prisma changes for ONE migration named 20261014090000_finance_wave_b, as exact
   model/field/enum blocks to add or change (with the target model names in the current schema), merged across all 7 areas with every critic
   correction applied. Resolve overlaps (the same model touched by several areas: Order, Concept, OperationsConfig, InventoryItem,
   RecipeIngredient, Recipe, SupplierBill(+Line), Supplier, GiftCard, CashVoucher(+Attachment), PettyCashMovement, PettyCashBox,
   FixedAsset, CapexLine, CapexPayment, ReceivableInvoice, Customer*, HrRecord etc.). New tables: tenantId (indexed), per-company uniques, BIGINT
   for company-level money, INT4 for per-ticket/per-unit/per-person. Also list SQL-only parts (CHECKs, partial uniques, RLS policies with the
   app_is_service_mode()/app_tenant_ids() guard pattern of migration 20261013150000, backfills that must run in the migration) separately.
   An enum value added to an existing enum must be its own earlier migration (Postgres) — name it 20261014085900_* if needed.
2. ${W}/chart-merged.md — every NEW chart code across areas, unique, with name/type/required, and every existing code newly REQUIRED; resolve
   collisions (e.g. 1356 vs others, 2120 Due to Garibsons vs the inter-company 2150-2199 range, 6036, 6155, 6170-6180, 2012, 2015, 2042-2044,
   1335, 1355, 1360, 1500-1599, 4110, 4200, 1115 till clearing if the onaccount area chose it). Give the ACCT constant names for journal.ts.
3. ${W}/shared-files.md — for EVERY shared file named in any plan's shared_file_changes (orderPosting.ts, shiftPosting.ts, pricing.ts,
   journal.ts, chartOfAccounts.ts, salesTaxReturn.ts, connectors/fiscal/payload.ts, dispatch/service.ts, pos/service.ts, orders/service.ts,
   inventory/*, procurement/*, trustops/*, giftCards/*, receivables/*, accounting/routes.ts, accounting/reports.ts, approvals/*, index.ts,
   lib/moduleAccess.ts, lib/workspaces.ts, admin lib/moduleCatalog.ts, lib/tenders.ts, lib/exceptions.ts, setup-config, reconciliation/*,
   storefront routes, mobile, tablet …): the merged list of changes from all areas, and ONE owning builder agent (by wave) per file so no two
   agents ever edit the same file at the same time. Files only one area touches stay with that area's builder.
4. ${W}/build-waves.md — the build as sequential WAVES of parallel builder agents. Each agent: id, area, the exact files it owns (disjoint from
   every other agent in the same wave), its tasks (from the area plan + critic corrections + merged shared changes it owns), the functions/
   contracts it must expose to agents in later waves (names + signatures), and its tests (two-company tests for routes; test DB name
   servd_test_wb_<id> and a distinct Redis index 0-31 on port 6390 each). Order waves so a contract is built before its consumers
   (e.g. inventory class + FIFO lots + stock-in function before petty-cash stock lines; the chart + ACCT before everything; taxAuthorities +
   withholding resolver before OpEx/CapEx; depreciation 'charged through' function before the period-close checklist). Aim for 3-4 waves,
   at most ~8 agents per wave. Orchestrator-only items (schema.prisma, the migration, chartOfAccounts.ts, journal.ts ACCT) are done BEFORE wave 1
   — list them as "wave 0 (orchestrator)".
5. ${W}/briefs/<agent-id>.md — one self-contained brief per builder agent (what to build, owned files, contracts to consume/expose, rules,
   tests, report format), so each builder can work from its brief alone plus CLAUDE.md.
Be exhaustive: nothing from any area plan or critic may be lost. Prefer extending existing code; never two sources of truth.`, { label: 'merge', phase: 'Merge', schema: MERGE_SCHEMA })

phase('Verify')
const verified = await agent(`${CTX}

An integration architect merged the 7 Wave B designs into: ${W}/schema-merged.prisma.md, ${W}/chart-merged.md, ${W}/shared-files.md,
${W}/build-waves.md and ${W}/briefs/*.md. Its summary: ${JSON.stringify(merged)}

Verify adversarially: (1) every schema/chart/route/posting/UI item and every critic correction from the 7 area plans is present in some brief;
(2) no chart code or model field collides or is defined twice differently; (3) within each wave no two agents own the same file; every
contract is produced in an earlier wave than its consumers; (4) the owner decisions file is followed (final packaging rule, delivery code only
+ emergency overrides, cash request flow, on-account QR without manager approval, CEO-only Raast void and bad-debt approval, no opening
assets, CapEx-only equipment, smallwares pools, FIFO real-time costing, delivery fee tax on top, gratuity etc.); (5) company separation and
money rules (BIGINT/INT4, RLS, tenantId) hold in the schema. Fix problems directly in those output files where you can (they are scratch
files, not repo files) and report.`, { label: 'verify-merge', phase: 'Verify', schema: VERIFY_SCHEMA })

return { merged, verified }
