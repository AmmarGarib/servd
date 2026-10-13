export const meta = {
  name: 'audit-fix-review',
  description: 'Adversarially review each area\'s uncommitted audit fixes, verify every finding with two independent lenses, then fix confirmed findings + follow-ups with tests',
  phases: [{ title: 'Review' }, { title: 'Verify' }, { title: 'Fix' }],
}

const ROOT = '/home/user/servd'
const SP = '/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad'
const TESTENV = (db, redis) => `cd ${ROOT}/backend && DATABASE_URL=postgresql://postgres@127.0.0.1:5432/${db} REDIS_URL=redis://127.0.0.1:6379/${redis} JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only NODE_ENV=test npx vitest run <files>`

const RULES = `CONTEXT: servd (repo ${ROOT}) is a multi-company restaurant ERP; real staff onboard on Monday. Tonight a simulated-shift audit found ~110 confirmed bugs (reports in ${SP}/audit/<area>/report.json) and fix agents changed the code (UNCOMMITTED in the working tree; their reports are in ${SP}/audit/fixreports/<area>.md). CLAUDE.md is the rulebook (company separation via lib/tenantScope.ts — empty scope must DENY; ledger: postJournalEntry needs tenantId, debits == credits, period locks; GST tender split cash 15% / card 8%, never concept.taxRate; bumpCustomerRollups on completion; idempotency keyed on the right thing; no 'as never' casts on DB writes).
HARD RULES: never call production (servd.pk, api.servd.pk, admin.servd.pk, brand domains, the deploy webhook); never send real messages; do NOT commit/push/stash/checkout/reset — the working tree holds other agents' uncommitted work; do NOT run next build / next dev; never 'pkill -f' broad patterns. Create any Postgres DB you need with: psql -h 127.0.0.1 -U postgres -c 'create database <name>' (test DB names MUST contain 'test'). Test command template: ${TESTENV('<db>', '<redisIdx>')}.`

const FINDINGS = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: {
  id: { type: 'string' }, severity: { type: 'string', enum: ['blocker', 'high', 'medium', 'low'] }, title: { type: 'string' },
  file: { type: 'string' }, line: { type: 'number' }, scenario: { type: 'string' }, fix: { type: 'string' } },
  required: ['id', 'severity', 'title', 'file', 'scenario', 'fix'] } }, notes: { type: 'string' } }, required: ['findings'] }

const VERDICT = { type: 'object', properties: { verdict: { type: 'string', enum: ['real', 'not_real', 'inconclusive'] },
  severity: { type: 'string', enum: ['blocker', 'high', 'medium', 'low'] }, reason: { type: 'string' }, evidence: { type: 'string' } },
  required: ['verdict', 'reason'] }

const FIXED = { type: 'object', properties: {
  items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['fixed', 'not_fixed', 'not_needed'] }, note: { type: 'string' } }, required: ['id', 'status'] } },
  filesChanged: { type: 'array', items: { type: 'string' } },
  tests: { type: 'string' }, needsOtherFiles: { type: 'string' }, prodNotes: { type: 'string' } },
  required: ['items', 'filesChanged', 'tests'] }

function reviewPrompt(a) {
  return `${RULES}

You are an adversarial CODE REVIEWER for area "${a.key}" (${a.label}). Read-only: do not edit any tracked file (scratch scripts under ${ROOT}/backend/.sim/review-${a.key}/ are fine).
1. Read ${SP}/audit/fixreports/${a.key}.md (what the fix agent claims) and the original findings it fixed in ${a.audits}.
2. Read the uncommitted changes: cd ${ROOT} && git diff HEAD -- ${a.paths}  plus these new files: ${a.newFiles}. Read surrounding code as needed.
3. Hunt for REAL defects introduced or left by these changes: wrong money math (tax, totals, rounding, double counting, ledger lines that don't balance or hit wrong accounts/company), races (check-then-act without a lock; locks taken in inconsistent order -> deadlock), company leaks (missing scope, '?? undefined', trusting client ids), behaviour regressions for existing callers (admin pages, tablet app in ${ROOT}/tablet, storefront, workers) — e.g. a changed response shape or status code a caller depends on, migrations that would FAIL or corrupt real production data (unique keys over existing duplicates, NOT NULL without backfill, data reassignment), auth bypasses, idempotency holes, error paths that leave half-written state, and claims in the fix report that the code doesn't actually do. Also check that the original audit findings are actually fixed.
${a.extraReview || ''}
Be concrete: each finding needs file:line, a concrete failure scenario (inputs -> wrong result), and a proposed fix. No style nits, no speculative 'could be' items without a scenario. Return at most 15 findings, most severe first. Finding ids: ${a.key.toUpperCase()}-R1, R2, …`
}

function verifyPrompt(a, f, i, lens) {
  const db = `servd_test_v_${a.key}_${i}_${lens}`
  const lensText = lens === 'repro'
    ? `LENS = REPRODUCE: write a small vitest file under ${ROOT}/backend/.sim/review-${a.key}/ (copy fixture patterns from ${ROOT}/backend/tests/audit*.test.ts; vitest config may only include tests/ — if so run it with: npx vitest run --root ${ROOT}/backend --dir .sim/review-${a.key} or temporarily place it in tests/ under a name starting zzverify_ and DELETE it afterwards) against your own DB ${db} (create it) and Redis db ${a.redisBase + (i % 5)}. verdict=real only if you reproduced the failure scenario; not_real if your test shows correct behaviour; inconclusive if you could not build a repro.`
    : `LENS = CODE REASONING: trace the exact code paths (callers, DB constraints, transaction boundaries, the schema in backend/prisma/schema.prisma) and try hard to REFUTE the finding — e.g. a guard elsewhere, a constraint, an unreachable path, or a deliberate documented product rule. verdict=real only if the defect survives your attempt to refute it.`
  return `${RULES}

You are an independent VERIFIER. Area "${a.key}". Do not edit tracked files. Finding to check:
${JSON.stringify(f, null, 1)}
${lensText}
Re-rate severity honestly (blocker = money/data wrong or staff blocked; high = security/company leak or wrong with workaround; medium; low).`
}

function fixPrompt(a, confirmed) {
  return `${RULES}

NOTE: an earlier attempt at this fix was interrupted by a usage limit — partial edits may already exist in your files. Start with \`cd ${ROOT} && git diff HEAD --stat\` and \`git diff HEAD -- <your files>\`, then complete or correct that work instead of redoing it blindly.\n\nYou are the FIX agent for area "${a.key}" (${a.label}). You may edit ONLY these files: ${a.owns}. Other agents are editing other areas' files concurrently — never touch files outside your list; if a fix needs another file, describe the exact change in needsOtherFiles. Do NOT edit backend/prisma/schema.prisma (describe any schema need). Read ${SP}/audit/fixreports/${a.key}.md first for context.

A. CONFIRMED REVIEW FINDINGS (each was verified by independent agents; fix all, most severe first):
${confirmed.length ? JSON.stringify(confirmed, null, 1) : '(none)'}

B. FOLLOW-UPS from the earlier fix agents' reports (do these too):
${a.followUps}

For every change add/extend a regression test (two-company where scoping is involved) in ${a.testFiles}. Run your tests plus the area's existing tests with your own DB ${a.fixDb} (create it) and Redis db ${a.fixRedis}: ${TESTENV(a.fixDb, a.fixRedis)}. Also run \`npx tsc --noEmit -p .\` in backend (and in frontend/admin and/or frontend/storefront if you touched them) — your files must be clean. Report per item (use the finding ids, and F1, F2… for follow-ups in the order listed): fixed / not_fixed / not_needed with a note; files changed; test results; anything needing other files; and prodNotes (anything about production data or deploy order the owner must know).`
}

const results = await pipeline(
  args,
  (a) => agent(reviewPrompt(a), { label: `review:${a.key}`, phase: 'Review', schema: FINDINGS, effort: 'high' }),
  async (rev, a) => {
    const fs = (rev && rev.findings) || []
    if (!fs.length) return { a, rev, confirmed: [], dropped: [] }
    const judged = await parallel(fs.map((f, i) => async () => {
      const [r1, r2] = await parallel([
        () => agent(verifyPrompt(a, f, i, 'repro'), { label: `verify:${a.key}:${f.id}:repro`, phase: 'Verify', schema: VERDICT }),
        () => agent(verifyPrompt(a, f, i, 'reason'), { label: `verify:${a.key}:${f.id}:reason`, phase: 'Verify', schema: VERDICT }),
      ])
      const v1 = (r1 && r1.verdict) || 'inconclusive'
      const v2 = (r2 && r2.verdict) || 'inconclusive'
      // Keep when the repro reproduced it, or when the repro was inconclusive and the code trace could not refute it.
      const keep = v1 === 'real' || (v1 === 'inconclusive' && v2 === 'real')
      const sev = (r1 && r1.verdict === 'real' && r1.severity) || (r2 && r2.severity) || f.severity
      return { f: { ...f, severity: sev, verifierNotes: [r1 && r1.reason, r2 && r2.reason].filter(Boolean).join(' | ') }, keep, v1, v2 }
    }))
    const ok = judged.filter(Boolean)
    log(`${a.key}: ${ok.filter((j) => j.keep).length}/${fs.length} review findings confirmed`)
    return { a, rev, confirmed: ok.filter((j) => j.keep).map((j) => j.f), dropped: ok.filter((j) => !j.keep).map((j) => ({ id: j.f.id, title: j.f.title, v1: j.v1, v2: j.v2 })) }
  },
  async (st) => {
    const fix = await agent(fixPrompt(st.a, st.confirmed), { label: `fix:${st.a.key}`, phase: 'Fix', schema: FIXED, effort: 'high' })
    return { area: st.a.key, reviewNotes: st.rev && st.rev.notes, confirmed: st.confirmed, dropped: st.dropped, fix }
  },
)
return results