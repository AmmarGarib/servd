export const meta = {
  name: 'waveB-design',
  description: 'Design Wave B finance areas from the owner decisions: plan, schema delta, shared-file needs, disjoint build split, then a critic pass',
  phases: [
    { title: 'Design', detail: 'one designer per area' },
    { title: 'Critique', detail: 'a critic checks each plan against the owner decisions, CLAUDE.md and the code' },
  ],
}

const SP = '/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad'
const COMMON = `Repo /home/user/servd (Fastify+Prisma backend/, Next.js admin frontend/admin/, storefront frontend/storefront/, tablet/, rider/).
READ-ONLY design task: do not edit/create repo files, no builds/tests/dev servers, never call production. CLAUDE.md applies in full — read its
"Finance gaps, wave A", "Cash vouchers", "Raast QR", "POS connector + pre-bills", "Own-fleet delivery" and company-separation sections.
BINDING owner decisions (2026-10-13): /home/user/servd/.handoff/fixes/owner-decisions-20261013.md — read it first; where it conflicts with an
older design, the owner decision wins. Accountant-level defaults (build on the option marked def; Hasnain may change later): the QS array in
${SP}/hasnain-questions.html (ids H1-H30). Earlier verified findings + fix designs: ${SP}/finance-gaps-verified.json; fixed-asset and
food-cost map/verify/design: ${SP}/fa-foodcost-journal.json (keys None2..None5 hold verify/design objects). Wave A is live (commits 405ce1c..da9f710):
lib/bankAccounts.ts moneyAccountCode, SalesTaxPayment, credit notes, posting-failure REPOSTERS, trustops/pettyCash.ts writeMovementTx +
recordPettyCashSpendTx, cash vouchers (trustops/cashVouchers.ts) — EXTEND these, never duplicate.
Rules for your plan: company separation from the first line (tenantId on every new table, per-company unique keys, scope helpers, two-company
tests); ledger postings take tenantId from the source document, run inside the document's transaction, idempotent sourceType/sourceId,
period-lock aware; company-level money columns BIGINT (lib/money.ts); a new module id goes into lib/workspaces.ts + moduleAccess.ts gates;
admin colours via tokens; no emoji icons on the storefront; never add a direct FBR/SRB client (the fiscal POS files; any change to what a sale
contains must flow through completeOrder + the fiscal payload); a duplicate of an existing feature is forbidden — name the existing code you extend.
Where a detail is undecided and not in the owner file or Hasnain defaults, choose the safest sensible default and list it under assumptions.`

const AREAS = args && args.areas ? args.areas : []

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    area: { type: 'string' },
    summary: { type: 'string', description: 'plain-English: what will exist after the build, end to end' },
    extends_existing: { type: 'array', items: { type: 'string' }, description: 'existing code/tables/pages extended (paths) — nothing duplicated' },
    removes: { type: 'array', items: { type: 'string' }, description: 'code/pages/routes removed or replaced, with what replaces them' },
    schema_delta: { type: 'string', description: 'exact Prisma model/field/enum additions/changes + any SQL-only parts (partial uniques, RLS, backfills) for ONE migration' },
    chart_accounts: { type: 'array', items: { type: 'string' }, description: 'new chart codes: code, name, type, REQUIRED or not' },
    postings: { type: 'array', items: { type: 'string' }, description: 'every Dr/Cr with sourceType, company source, date, idempotency' },
    routes: { type: 'array', items: { type: 'string' }, description: 'method path guard module-gate body errors' },
    shared_file_changes: { type: 'array', items: { type: 'string' }, description: 'exact changes needed in files likely shared with other areas (orderPosting.ts, pricing.ts, journal.ts, chartOfAccounts.ts, salesTaxReturn.ts, fiscal payload, dispatch, pos/service.ts, index.ts, moduleAccess.ts, workspaces.ts, moduleCatalog.ts, approvals providers)' },
    build_split: {
      type: 'array',
      items: { type: 'object', properties: { agent: { type: 'string' }, owns_files: { type: 'array', items: { type: 'string' } }, tasks: { type: 'string' }, tests: { type: 'string' } }, required: ['agent', 'owns_files', 'tasks', 'tests'] },
      description: 'parallel builder agents with DISJOINT file sets (excluding the shared files above, which the orchestrator integrates)',
    },
    data_migration: { type: 'string', description: 'backfills / conversions of existing rows, and how they are safe to re-run' },
    assumptions: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['area', 'summary', 'extends_existing', 'removes', 'schema_delta', 'chart_accounts', 'postings', 'routes', 'shared_file_changes', 'build_split', 'data_migration', 'assumptions', 'risks'],
}
const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    violations: { type: 'array', items: { type: 'string' }, description: 'plan items that contradict an owner decision, CLAUDE.md, company separation, money rules, or duplicate existing code — each with the fix' },
    missing: { type: 'array', items: { type: 'string' }, description: 'pieces the owner decision needs that the plan forgot (UI, permissions, workers, backfills, tests, docs)' },
    code_facts: { type: 'array', items: { type: 'string' }, description: 'facts from the code the plan got wrong, with file:line' },
    corrected_plan_notes: { type: 'string', description: 'concise list of changes to apply to the plan' },
  },
  required: ['violations', 'missing', 'code_facts', 'corrected_plan_notes'],
}

const out = await pipeline(
  AREAS,
  (a) => agent(`${COMMON}

AREA ${a.key}: ${a.title}
${a.brief}

Design the complete build for this area. Read the existing code first (grep widely) and name exact files/functions.`, { label: `design:${a.key}`, phase: 'Design', schema: PLAN_SCHEMA }),
  (plan, a) => agent(`${COMMON}

AREA ${a.key}: ${a.title}
${a.brief}

A designer produced the plan below. Be a skeptical critic: check it against the owner decisions file, the Hasnain defaults, CLAUDE.md and the
actual code (open the files it names). Report violations, missing pieces and wrong code facts, with concrete corrections.

PLAN:
${JSON.stringify(plan, null, 1)}`, { label: `critic:${a.key}`, phase: 'Critique', schema: CRITIC_SCHEMA }).then((c) => ({ area: a.key, plan, critic: c })),
)
return out.filter(Boolean)
