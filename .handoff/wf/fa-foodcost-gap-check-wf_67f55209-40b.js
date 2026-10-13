export const meta = {
  name: 'fa-foodcost-gap-check',
  description: 'Verify what exists for fixed assets/depreciation and actual-vs-recipe food cost, adversarially check the gaps, design extensions',
  phases: [
    { title: 'Map', detail: 'one deep reader per area: what exists, how deep, what is missing' },
    { title: 'Verify', detail: 'skeptic re-checks every claimed gap and hunts missed ones' },
    { title: 'Design', detail: 'extend-the-existing build plan per area + owner questions' },
  ],
}

const RULES = `Context: repo /home/user/servd (Fastify+Prisma backend in backend/, Next.js admin in frontend/admin/). READ-ONLY: do not edit, create or delete any file, do not run builds, dev servers, tests or migrations, never call production URLs. CLAUDE.md applies (company separation, flag duplicates, one source of truth). The product owner believes these features are MISSING from servd. Base layers may exist. Your job is facts with file:line evidence, not opinions.`

const AREAS = [
  {
    key: 'fixed_assets',
    title: 'Fixed asset register and monthly depreciation',
    owner: 'Owner: "Fixed asset register and monthly depreciation. The capex tracker records spending, not assets that depreciate."',
    scope: `Start at backend/src/modules/fixedAssets/{routes,service}.ts, schema models FixedAsset and FixedAssetDepreciation in backend/prisma/schema.prisma (and their migrations), frontend/admin/src/app/accounting/fixed-assets/page.tsx, the CapEx tracker (backend/src/modules/financePlanning/{routes,capexPosting}.ts, schema CapexProject/CapexLine/CapexQuote/CapexPayment, frontend/admin/src/app/finance/capex/page.tsx), the chart (backend/src/lib/chartOfAccounts.ts: 1340 Advances to Suppliers, 1510-1550 asset classes, 1590 Accumulated Depreciation, 6150 Depreciation Expense, 8030 Gain/Loss on Disposal), postJournalEntry/period locks (backend/src/modules/accounting/journal.ts), workers (backend/src/workers/, backend/src/index.ts registration), supplier bills (accounting/supplierPosting.ts, procurement), reports (balance sheet / P&L / cash flow in accounting), moduleCatalog/sidebar (frontend/admin/src/lib/moduleCatalog.ts, components/ui/AppShell.tsx, backend/src/lib/workspaces.ts, backend/src/lib/moduleAccess.ts GATED_PREFIXES), tests under backend/tests mentioning fixed asset / depreciation / capex.
Answer precisely: (1) Is there a register (fields: tag/code, name, category/class, location, brand, company, supplier, purchase date, in-service date, cost, salvage/residual, useful life, method, status, NBV, disposal)? (2) How is an asset CREATED — by hand only, or automatically when a CapEx project/line is completed/capitalised or a bill is paid? Does CapEx spend sit forever in 1340 or is it moved to 15xx? (3) Depreciation: methods supported, how computed (monthly? daily? first-month convention), is there an AUTOMATIC monthly run (worker/cron per company) or only a manual POST /depreciate button; idempotency per asset per month; does it post Dr 6150 / Cr 1590 per company, respect period locks, tag brand/location; catch-up for missed months; what happens to fully depreciated assets. (4) Disposal/sale/write-off posting (8030), partial disposal, transfer between locations/brands, impairment. (5) Reports: register listing, depreciation schedule/forecast, NBV by class/location/brand, movement roll-forward (opening cost + additions - disposals = closing; same for accumulated depreciation) that a CA needs for the financial-statement note; tax depreciation (Pakistan Income Tax Ordinance 2001 Third Schedule: tax WDV rates, initial allowance) vs book. (6) Company separation correctness (tenantId, scopeTenantWhere modes, two-company tests). (7) Can a CEO/finance user find it (which sidebar entry, which module id, which roles)? (8) Tests that exist.`,
  },
  {
    key: 'food_cost',
    title: 'Actual vs recipe (theoretical) food cost variance',
    owner: 'Owner: "Actual vs recipe food cost. This is servd\'s core selling point, but the Reports module lists only sales, items, hours and channels. No variance report is on the map."',
    scope: `Start at frontend/admin/src/app/accounting/food-cost/page.tsx and the API it calls, backend/src/modules/recipes/routes.ts (around the "Actual cost" block near line 1392 and 1473), backend/src/lib/recipeCost.ts, backend/src/modules/accounting/orderPosting.ts (COGS at sale — theoretical COGS?), inventory (backend/src/modules/inventory/: stock counts/stocktakes, waste logs, voidWaste.ts, receiving, transfers backend/src/modules/stockTransfers), procurement receiving (backend/src/modules/procurement), the Reports module (backend/src/modules/reports, backend/src/modules/opsReports, frontend/admin/src/app/reports/**, whatever lists 'sales, items, hours, channels'), menu engineering (/accounting/menu-engineering), par sheets, moduleCatalog/sidebar (frontend/admin/src/lib/moduleCatalog.ts, backend/src/lib/workspaces.ts), scheduled reports (frontend/admin/src/app/configuration/scheduled-reports), tests in backend/tests.
Answer precisely: (1) What the food-cost page shows today and how each number is computed (cite code). Is "actual" from the LEDGER (5xxx), from STOCK USAGE (opening count + purchases received ± transfers − closing count), or something else? Is "theoretical/recipe" Σ(qty sold × recipe cost) including modifiers, sub-recipes/prep yields, voids, comps, staff meals? (2) Is there an INGREDIENT-LEVEL actual-vs-theoretical usage variance (qty and PKR) per ingredient, per brand, per location, per period — the classic AvT report? Is there per-menu-item theoretical food cost %? (3) Do stocktakes/counts exist with period boundaries so actual usage can be computed? Are waste logs and transfers captured so variance can be split into explained (waste, staff meals, comps, transfers) vs unexplained? (4) Where does it sit in navigation — is it under Finance/Accounting rather than Reports, and which roles/modules can open it? Do the Ops/BOH managers (fnb_manager, kitchen roles) see it? (5) Which reports does the Reports module list today (exact list with files)? (6) Company separation correctness and tests. (7) Data prerequisites that real operators may lack (recipes with costs, counts) and how the page behaves when missing.`,
  },
]

const MAP_SCHEMA = {
  type: 'object',
  properties: {
    exists_summary: { type: 'string', description: 'Plain-English: what exists today, how deep, one paragraph' },
    existing_paths: { type: 'array', items: { type: 'string' }, description: 'files / routes / pages / models / workers that implement this today' },
    navigation: { type: 'string', description: 'where a CEO / finance / ops user finds it, module id, roles' },
    works: { type: 'array', items: { type: 'string' }, description: 'capabilities verified working, each with file:line' },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          evidence: { type: 'string', description: 'file:line and what the code does today' },
          impact: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
        },
        required: ['id', 'title', 'evidence', 'impact', 'severity'],
      },
    },
    company_separation_issues: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'string' } },
  },
  required: ['exists_summary', 'existing_paths', 'navigation', 'works', 'gaps', 'company_separation_issues', 'tests'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    confirmed_gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, evidence: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
        },
        required: ['id', 'title', 'evidence', 'severity'],
      },
    },
    refuted_gaps: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, why: { type: 'string' } }, required: ['id', 'why'] },
    },
    missed_gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, evidence: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
        },
        required: ['id', 'title', 'evidence', 'severity'],
      },
    },
    corrected_summary: { type: 'string', description: 'corrected plain-English statement of what exists and what does not' },
  },
  required: ['confirmed_gaps', 'refuted_gaps', 'missed_gaps', 'corrected_summary'],
}

const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    duplicate_flag: { type: 'string', description: 'What already exists (paths) and why the plan EXTENDS it rather than building a second one' },
    plan: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          step: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          details: { type: 'string', description: 'concrete: schema fields, migration, routes, ledger lines (Dr/Cr codes), worker cadence, admin UI, company scoping, gates' },
          closes_gaps: { type: 'array', items: { type: 'string' } },
        },
        required: ['step', 'files', 'details', 'closes_gaps'],
      },
    },
    schema_changes: { type: 'string' },
    ledger_postings: { type: 'string', description: 'every Dr/Cr the change posts, per company, with idempotency key and period-lock behaviour' },
    tests: { type: 'array', items: { type: 'string' }, description: 'tests to add incl. two-company tests' },
    owner_questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          recommended_default: { type: 'string' },
          blocks_build: { type: 'boolean', description: 'true only if the build cannot proceed with the recommended default' },
        },
        required: ['question', 'recommended_default', 'blocks_build'],
      },
    },
    disjoint_work_split: { type: 'array', items: { type: 'string' }, description: 'how to split the build into agents with DISJOINT file sets (backend vs admin etc.)' },
  },
  required: ['duplicate_flag', 'plan', 'schema_changes', 'ledger_postings', 'tests', 'owner_questions', 'disjoint_work_split'],
}

const results = await pipeline(
  AREAS,
  (a) => agent(`${RULES}

AREA: ${a.title}
${a.owner}

Map exactly what exists for this area today, how deep it goes, and every real gap against what a professional restaurant group (and its chartered accountant) needs. Trace end to end — schema → service → routes → workers → ledger → admin page → navigation → tests.
${a.scope}

Every "works" item and every gap needs file:line evidence. Do not list a gap you have not checked in the code.`, { label: `map:${a.key}`, phase: 'Map', schema: MAP_SCHEMA }),
  (m, a) => agent(`${RULES}

AREA: ${a.title}
${a.owner}

Another investigator produced the map below. Be a skeptic. For EVERY gap: open the cited code and try to REFUTE it (the capability may exist elsewhere — grep widely: other modules, workers, admin pages, migrations). Default to refuted only when you find the capability; otherwise confirm. Then act as a completeness critic: hunt for gaps the map MISSED (ledger correctness, company separation, period locks, idempotency, navigation/discoverability, reports a CA needs, prerequisites like stock counts, tests). Also correct the exists_summary if it is wrong in either direction.

MAP:
${JSON.stringify(m, null, 1)}`, { label: `verify:${a.key}`, phase: 'Verify', schema: VERIFY_SCHEMA }).then((v) => ({ map: m, verify: v })),
  (mv, a) => agent(`${RULES}

AREA: ${a.title}
${a.owner}

Design the build that closes EVERY confirmed and missed gap below by EXTENDING the existing implementation (CLAUDE.md duplicate rule: no second register, no second report engine, no second depreciation path). Follow servd rules: tenantId on every new table + per-company unique keys; routes via lib/tenantScope.ts; postJournalEntry requires tenantId, resolved from the source row; period locks respected; workers loop per company and are idempotent (unique key per asset per month etc.); money columns at company level are BIGINT via lib/money.ts helpers; admin colours via tokens only; a new module id must be placed in a workspace in backend/src/lib/workspaces.ts and gated in moduleAccess.ts; a new caller of a gated path adds its module to that rule; two-company tests for every new route. Give recommended defaults for every owner question so the build can start immediately; mark blocks_build only if truly impossible without the answer. Split the work so parallel agents get disjoint file sets (shared files like schema.prisma, index.ts, workspaces.ts, moduleAccess.ts, moduleCatalog.ts are integrated by the orchestrator — list them separately).

MAP:
${JSON.stringify(mv.map, null, 1)}

VERIFICATION:
${JSON.stringify(mv.verify, null, 1)}`, { label: `design:${a.key}`, phase: 'Design', schema: DESIGN_SCHEMA }).then((d) => ({ area: a.key, map: mv.map, verify: mv.verify, design: d })),
)

return results.filter(Boolean)
