export const meta = {
  name: 'resim',
  description: 'Re-run the simulated shifts per area against the current code: confirm each original finding is fixed, adapt to intended behaviour changes, hunt regressions, then adversarially verify every new finding',
  phases: [{ title: 'Simulate' }, { title: 'Verify' }],
}

const ROOT = '/home/user/servd'
const SP = '/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad'
const ORIG = '/root/.claude/projects/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/workflows/scripts/erp-shift-audit-wf_06a8829c-15b.js'

const CHANGES = `INTENDED behaviour changes since the first audit (do NOT report these as bugs; adapt your scripts to them, and DO report if they are implemented wrongly):
- Manager-only voids: every item void and every whole-order cancel/void of a rung-up order needs a manager login or a valid same-company manager PIN (403 MANAGER_OVERRIDE_REQUIRED / INVALID_MANAGER_PIN); approverId recorded.
- Pre-bills vs full & final bill: printing a bill for an OPEN order is a pre-bill (POST /pos/orders/:id/pre-bill, PB-<n> per company, never fiscal, never revenue); receipt routes answer 409 PRE_BILL_REQUIRED for a non-final order. Finance -> Voided pre bills lists every pre-bill with flags.
- Fiscal filing ONLY through the POS connector (backend/src/connectors, CLAUDE.md 'POS connector + pre-bills'): a sale files exactly once at completion as a FiscalDocument; until the CEO goes live the company's documents are 'held'; the 'test' driver gives TEST-… numbers; per-company 'fiscal reporting required' switch. Direct FBR/SRB code and /integrations/tax/status are GONE.
- Card machine (terminal connector): while a charge is active, voids/cancels/gift-card/loyalty bill changes answer 409 TERMINAL_CHARGE_ACTIVE; keyed card slips only with manualReason 'terminal_offline' and only if allowManualRef is on.
- Access (wave 3): module gates on /orders, /expo, /dispatch, /riders, /crm, finance/HR prefixes (lib/moduleAccess.ts GATED_PREFIXES, readAnyOf for finance reads of /procurement payables); marketing/finance/IT/HR/boh got their workspace routes; line cooks see no costs (costsHidden), finance sees masked gift-card codes; the brand picker is GET /concepts?view=picker; the admin has a page guard.
- CEO workspace + ONE approvals inbox (GET /approvals, /approvals/counts; inline actions call each module's own route). Operations is owned by fnb_manager.
- Auth: every user joins their own company (membership backfill); login approval needs a company (422 LOGIN_NEEDS_COMPANY).
Read CLAUDE.md fully first — it documents all of this.`

const COMMON = `You are RE-RUNNING a simulated shift for servd (repo ${ROOT}; CLAUDE.md is the rulebook), a multi-company restaurant ERP whose real staff onboard on Monday. Last night an audit simulated shifts per area and found bugs; since then ~300 files were changed to fix them (UNCOMMITTED working tree — that IS the code under test). Your job: (1) prove each ORIGINAL finding of your area is now fixed or not, (2) re-run the whole shift end to end against the CURRENT code, and (3) find anything new that is broken (regressions from the fixes) — with evidence.
The original audit script (your area's brief, env setup and rules) is ${ORIG} — read COMMON and your area's entry there; the SAME hard rules apply (read-only on tracked files; never call production; never send real messages; no next build/dev; act as real staff over HTTP with real logins; check DB state, ledger balance and company separation, not just status codes). Your area's original report is ${SP}/audit/<area>/report.json and your previous scripts are in ${ROOT}/backend/.sim/<area>/ — reuse them; put NEW scripts in ${ROOT}/backend/.sim/<area>-r2/ and notes/evidence in ${SP}/audit/<area>-r2/.
${CHANGES}
ENV for this re-run (different from the first run so nothing collides): your DB, port and Redis db are given below — build the schema with prisma db push + the raw-SQL objects from backend/tests/setup.ts exactly as the original COMMON describes, start your API from the CURRENT tree (cd ${ROOT}/backend && DATABASE_URL=… REDIS_URL=… JWT_SECRET=sim-secret-<area>-r2-not-real-000000000 JWT_REFRESH_SECRET=sim-refresh-<area>-r2-not-real-00000000 NODE_ENV=development ENABLE_WORKERS=true PORT=<port> HOST=127.0.0.1 nohup npx tsx src/index.ts > ${SP}/audit/<area>-r2-api.log 2>&1 &), configure the fiscal connector with the built-in 'test' driver for company A (via the real /connectors routes as the CEO) so the fiscal path is exercised without a network, leave company B unconfigured. Read your API log for errors at the end. STOP your API process (kill the PID you started) when done. Other agents may edit a few files while you run (admin pages, gift cards/loyalty, connector routes) — your API process is already loaded, so note the time you started it.
OUTPUT: originals = every ORIGINAL finding id of your area with status fixed / not_fixed / changed_by_design / could_not_test + one-line evidence; findings = NEW problems only (not originals), each with severity (blocker = staff can't do their job or money/data wrong; high = wrong with workaround / security / company leak; medium; low), exact repro (HTTP calls), expected vs actual, evidence (bodies, DB rows, log lines), suspected file:line, suggested fix; coverage = every journey run with pass/fail. Be honest: no speculation; if you couldn't run something, say so.`

const AREAS = {
  foh:    { db: 'servd_sim_foh_r2',    port: 4111, redis: 21 },
  boh:    { db: 'servd_sim_boh_r2',    port: 4112, redis: 22 },
  people: { db: 'servd_sim_people_r2', port: 4113, redis: 23 },
  online: { db: 'servd_sim_online_r2', port: 4114, redis: 24 },
  books:  { db: 'servd_sim_books_r2',  port: 4115, redis: 25 },
  ui:     { db: 'servd_sim_ui_r2',     port: 4200, redis: 6, note: `UI AREA NOTES: the orchestrator serves a fresh admin production build of the CURRENT tree at http://localhost:3200 (dir ${SP}/admin-build), hard-wired to the API on :4200 — start YOUR API on 4200 with YOUR DB, and do NOT stop the :3200 server. Crawl every role (desktop + phone width) with Playwright (node ${SP}/pw/node_modules, executablePath /opt/pw-browsers/chromium-1194/chrome-linux/chrome); reuse ${SP}/audit/ui/gen, seed.ts and the crawl scripts. Check wave 3: every sidebar page of every role loads without a 403 toast, pages outside a role's modules show the 'no access' panel, no red error toast on load, the CEO workspace + /ceo/approvals inbox, the tablet-equivalent admin till (/pos) for cashier, the refund 'Money taken' banner on a cancelled paid order for a manager.` },
}

const SIM = { type: 'object', properties: {
  originals: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['fixed', 'not_fixed', 'changed_by_design', 'could_not_test'] }, evidence: { type: 'string' } }, required: ['id', 'status'] } },
  findings: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, severity: { type: 'string', enum: ['blocker', 'high', 'medium', 'low'] }, title: { type: 'string' }, repro: { type: 'string' }, expected: { type: 'string' }, actual: { type: 'string' }, evidence: { type: 'string' }, suspectedCause: { type: 'string' }, suggestedFix: { type: 'string' } }, required: ['id', 'severity', 'title', 'repro', 'expected', 'actual'] } },
  coverage: { type: 'array', items: { type: 'object', properties: { journey: { type: 'string' }, result: { type: 'string', enum: ['pass', 'fail', 'partial', 'not_run'] }, note: { type: 'string' } }, required: ['journey', 'result'] } },
  envNotes: { type: 'string' } },
  required: ['originals', 'findings', 'coverage'] }
const VERDICT = { type: 'object', properties: { verdict: { type: 'string', enum: ['real', 'not_real', 'inconclusive'] }, severity: { type: 'string', enum: ['blocker', 'high', 'medium', 'low'] }, reason: { type: 'string' }, evidence: { type: 'string' } }, required: ['verdict', 'reason'] }

const keys = (args && args.length) ? args : Object.keys(AREAS)
const results = await pipeline(
  keys,
  (k) => { const a = AREAS[k]; return agent(`${COMMON}\n\nYOUR AREA: ${k}. DB ${a.db} (create it), API port ${a.port}, Redis db ${a.redis} (flush only yours).${a.note ? '\n' + a.note : ''}`, { label: `sim:${k}`, phase: 'Simulate', schema: SIM, effort: 'high' }) },
  async (sim, k) => {
    const fs = ((sim && sim.findings) || []).filter((f) => f.severity !== 'low')
    const lows = ((sim && sim.findings) || []).filter((f) => f.severity === 'low')
    if (lows.length) log(`${k}: ${lows.length} low findings kept unverified`)
    const judged = await parallel(fs.map((f, i) => () => agent(`You are an independent VERIFIER for a servd re-run finding (repo ${ROOT}; CLAUDE.md is the rulebook; read-only on tracked files; never call production; no next build/dev).\n${CHANGES}\nFinding (area ${k}):\n${JSON.stringify(f, null, 1)}\nTry hard to REFUTE it: is it an intended behaviour change above, a test-setup mistake (wrong role/module/company/connector config), or real? Trace the code paths; reproduce with a small vitest file under ${ROOT}/backend/.sim/${k}-r2/verify/ run against your own DB servd_test_rv_${k}_${i} (create it) and Redis db ${26 + (i % 5)} (copy fixture patterns from backend/tests/*.test.ts; the vitest config may only include tests/ — then place it temporarily in tests/ as zzverify_${k}_${i}.test.ts and DELETE it afterwards). verdict=real only if it survives; re-rate severity honestly.`, { label: `verify:${k}:${f.id}`, phase: 'Verify', schema: VERDICT }).then((v) => ({ ...f, verdict: v }))))
    return { area: k, originals: sim && sim.originals, coverage: sim && sim.coverage, envNotes: sim && sim.envNotes, confirmed: judged.filter(Boolean).filter((j) => j.verdict && j.verdict.verdict === 'real'), rejected: judged.filter(Boolean).filter((j) => !j.verdict || j.verdict.verdict !== 'real').map((j) => ({ id: j.id, title: j.title, verdict: j.verdict })), lows }
  },
)
return results