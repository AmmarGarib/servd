export const meta = {
  name: 'waveb-gate',
  description: 'Gate a finished wave-B stage: apply patch notes and gate items, tsc, every builder test, focused money review',
  phases: [{ title: 'Gate', detail: 'patch notes, gate checklist, tsc, tests' }, { title: 'Review', detail: 'money / tax correctness of this stage' }],
}

const SP = '/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB'
const wave = args?.wave || 'W1'
const journals = Array.isArray(args?.journals) ? args.journals : []
const reviewFocus = args?.reviewFocus || ''
const db = args?.db || 'servd_test_wb_gate'
const redis = args?.redis ?? 25

const COMMON = `Repo /home/user/servd (read CLAUDE.md; it applies). Wave B of the finance build, stage ${wave} just finished. Plan files: ${SP}/build-waves.md
(read its "Gates between waves" section and the ${wave} table), ${SP}/shared-files.md, ${SP}/parked/PARKED.md (binding: parked areas stay parked).
The builders' reports are the "type":"result" lines of these workflow journals: ${journals.join(', ')} (one JSON line per finished builder; the
'result' field is the report, including its "Patch notes" section).
Tests: from backend/, DATABASE_URL=postgresql://postgres@127.0.0.1:5432/<db> REDIS_URL=redis://127.0.0.1:6390/<idx>
JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only
SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run <files>. Never production, never
git commit/stash/reset/checkout (the orchestrator commits), no next build, no dev server.`

const GATE_SCHEMA = { type: 'object', properties: {
  summary: { type: 'string' },
  patchNotesApplied: { type: 'array', items: { type: 'string' } },
  gateItems: { type: 'array', items: { type: 'string' } },
  tscBackend: { type: 'string' }, tscAdmin: { type: 'string' },
  tests: { type: 'array', items: { type: 'object', properties: { files: { type: 'string' }, passed: { type: 'number' }, failed: { type: 'number' }, note: { type: 'string' } }, required: ['files', 'passed', 'failed', 'note'] } },
  fixesMade: { type: 'array', items: { type: 'string' } },
  blockers: { type: 'array', items: { type: 'string' } },
  notesForNextStage: { type: 'array', items: { type: 'string' } } },
  required: ['summary', 'patchNotesApplied', 'gateItems', 'tscBackend', 'tscAdmin', 'tests', 'fixesMade', 'blockers', 'notesForNextStage'] }

const REVIEW_SCHEMA = { type: 'object', properties: {
  summary: { type: 'string' },
  findings: { type: 'array', items: { type: 'object', properties: {
    file: { type: 'string' }, line: { type: 'number' }, severity: { type: 'string', enum: ['money-wrong', 'company-leak', 'tax-wrong', 'crash', 'minor'] },
    problem: { type: 'string' }, failureScenario: { type: 'string' }, fixApplied: { type: 'string' } },
    required: ['file', 'severity', 'problem', 'failureScenario', 'fixApplied'] } } },
  required: ['summary', 'findings'] }

phase('Gate')
const gate = await agent(COMMON + `
YOUR JOB (gate keeper for ${wave}). Database ${db}, Redis index ${redis} (create the DB if missing; tests db-push it).
1. Read every report. Apply each "Patch notes" item that targets a file NO builder of a later stage owns (shared-files.md says who owns what; the
   orchestrator-owned files in §A are yours to patch now, e.g. index.ts registrations are NOT — those are wave Z, leave them and list them in
   notesForNextStage). Patch notes for a file a later-stage builder owns: do not apply — list them in notesForNextStage with the target builder id.
2. Do every gate item build-waves.md lists for ${wave} (including the "after ${wave} only" parked-work items).
3. Run \`npx tsc --noEmit -p .\` in backend and in frontend/admin; fix errors that come from this stage's code (small, local fixes only; anything
   bigger → blockers).
4. Run EVERY test file the ${wave} builders wrote or changed (their reports list them) plus the existing suites they name, on your DB; then the
   key cross-checks: tests/moneyBigint.test.ts, accessControl, approvalsInbox, journal, booksLedger, cashControls. Fix failures caused by this
   stage when the fix is clear and local; otherwise blockers (with the failing test, the error, and the file).
5. Never touch parked areas (PARKED.md A/B) except to revert parked behaviour a builder landed by mistake.
Report precisely.`, { label: `gate:${wave}`, phase: 'Gate', schema: GATE_SCHEMA, model: 'opus' })

phase('Review')
const review = await agent(COMMON + `
YOUR JOB (money reviewer for ${wave}) — runs after the gate keeper (its report is below). Review ONLY the money, tax, ledger and company-separation
code this stage added or changed: ${reviewFocus}
For each: read the code, think through concrete inputs (two companies, a closed month, a replay, a partial refund, rounding, concurrency) and
look for: postings that do not balance or land in the wrong company or account, double posting on replay, a closed month bypassed, wrong tax
maths, a foreign company's row readable or attachable, a race that double-spends. Fix every real finding directly (small, local, with a test when
cheap), run the affected tests on database ${db} Redis ${redis}, and report each finding with the fix. Do not report style. If nothing is wrong,
say so — no invented findings.
Gate keeper report: ` + JSON.stringify(gate).slice(0, 5000), { label: `review:${wave}`, phase: 'Review', schema: REVIEW_SCHEMA, model: 'opus' })

return { gate, review }
