// Load test for servd's order ingestion path.
//
// Goal: simulate dinner-rush concurrent order placement and verify (a) the API
// stays under target latency and (b) the ledger remains consistent — sum of
// debits across journal_lines must equal sum of credits at the end.
//
// Default profile: 50 concurrent virtual users for 60 seconds, ~1 order each
// every 2-3 seconds. Tune RAMP_USERS / DURATION_SEC / RPS_PER_USER to taste.
//
// Usage:
//   API_URL=https://api.staging.servd.pk \
//   API_TOKEN=<staff-jwt> \
//   CONCEPT_ID=<uuid> \
//   pnpm --filter @servd/api exec tsx ../../scripts/load-test.ts
//
// Reads ADMIN_DB_URL (or DATABASE_URL) for the ledger consistency check at end.
// Don't run this against production — staging only.

import { setTimeout as sleep } from 'node:timers/promises'
import { Client } from 'pg'

const API_URL    = process.env.API_URL    ?? 'http://localhost:3001'
const API_TOKEN  = process.env.API_TOKEN  ?? ''
const CONCEPT_ID = process.env.CONCEPT_ID ?? ''
const DB_URL     = process.env.ADMIN_DB_URL ?? process.env.DATABASE_URL ?? ''

const RAMP_USERS    = parseInt(process.env.RAMP_USERS    ?? '50',  10)
const DURATION_SEC  = parseInt(process.env.DURATION_SEC  ?? '60',  10)
const PAUSE_MS_MIN  = parseInt(process.env.PAUSE_MS_MIN  ?? '1500', 10)
const PAUSE_MS_MAX  = parseInt(process.env.PAUSE_MS_MAX  ?? '3500', 10)
const SLO_P95_MS    = parseInt(process.env.SLO_P95_MS    ?? '500', 10)
const SLO_ERROR_PCT = parseFloat(process.env.SLO_ERROR_PCT ?? '1.0')

if (!API_TOKEN || !CONCEPT_ID) {
  console.error('Set API_TOKEN and CONCEPT_ID')
  process.exit(1)
}
if (API_URL.includes('servd.pk') && !API_URL.includes('staging')) {
  console.error('Refusing to load-test production. Set API_URL to staging.')
  process.exit(1)
}

interface Sample { ms: number; status: number; ok: boolean }
const samples: Sample[] = []

async function placeOrder(): Promise<Sample> {
  const total = 50_000 + Math.floor(Math.random() * 200_000)  // 500–2500 PKR
  const body = {
    source: 'manual',
    external_id: `loadtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    concept_id: CONCEPT_ID,
    placed_at: new Date().toISOString(),
    customer_id: null,
    customer_name: 'LoadTest',
    items: [
      { externalItemId: 'lt', menuItemId: null, name: 'Load test item', quantity: 1, unitPriceCents: total, modifiers: [] },
    ],
    payment: { provider: 'cash', amountCents: total, status: 'paid' },
    loyalty_points_earned: null,
    delivery_notes: null,
    estimated_pickup: null,
  }

  const start = performance.now()
  let status = 0
  try {
    const res = await fetch(`${API_URL}/api/v1/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify(body),
    })
    status = res.status
    return { ms: performance.now() - start, status, ok: res.ok }
  } catch {
    return { ms: performance.now() - start, status: 0, ok: false }
  }
}

async function userLoop(stopAt: number, userId: number): Promise<void> {
  while (performance.now() < stopAt) {
    const sample = await placeOrder()
    samples.push(sample)
    if (!sample.ok) {
      // Don't hammer if 5xxs are happening — back off
      await sleep(500)
    }
    const pause = PAUSE_MS_MIN + Math.random() * (PAUSE_MS_MAX - PAUSE_MS_MIN)
    await sleep(pause)
  }
  console.error(`  user ${userId} done`)
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx]!
}

async function ledgerConsistency(): Promise<{ ok: boolean; delta: number; entries: number }> {
  if (!DB_URL) return { ok: false, delta: -1, entries: 0 }
  const client = new Client({ connectionString: DB_URL })
  await client.connect()
  try {
    const r = await client.query<{ delta: string; entries: string }>(`
      SELECT
        COALESCE(SUM(CASE WHEN type='debit'  THEN "amountCents" ELSE 0 END), 0)
       -COALESCE(SUM(CASE WHEN type='credit' THEN "amountCents" ELSE 0 END), 0) AS delta,
        COUNT(DISTINCT "journalEntryId")::text AS entries
      FROM journal_lines
      WHERE "journalEntryId" IN (
        SELECT id FROM journal_entries
        WHERE reference LIKE 'order.complete:%'
           OR reference LIKE 'order.complete.reversal:%'
      )
    `)
    const delta = parseInt(r.rows[0]!.delta, 10)
    return { ok: delta === 0, delta, entries: parseInt(r.rows[0]!.entries, 10) }
  } finally {
    await client.end()
  }
}

async function main() {
  console.error(`Load test: ${RAMP_USERS} users × ${DURATION_SEC}s against ${API_URL}`)
  console.error(`Pausing ${PAUSE_MS_MIN}–${PAUSE_MS_MAX}ms between requests per user`)
  console.error('')

  const stopAt = performance.now() + DURATION_SEC * 1000
  const users = Array.from({ length: RAMP_USERS }, (_, i) => userLoop(stopAt, i))
  await Promise.all(users)

  console.error('')
  console.error('── Results ──')

  const total = samples.length
  const errs  = samples.filter((s) => !s.ok).length
  const errPct = total > 0 ? (errs / total) * 100 : 0

  const okMs  = samples.filter((s) => s.ok).map((s) => s.ms)
  const p50   = pct(okMs, 0.50)
  const p95   = pct(okMs, 0.95)
  const p99   = pct(okMs, 0.99)
  const max   = okMs.length > 0 ? Math.max(...okMs) : 0
  const rps   = total / DURATION_SEC

  console.log(`requests:    ${total}`)
  console.log(`errors:      ${errs} (${errPct.toFixed(2)}%)`)
  console.log(`throughput:  ${rps.toFixed(1)} req/s`)
  console.log(`latency p50: ${p50.toFixed(0)} ms`)
  console.log(`latency p95: ${p95.toFixed(0)} ms`)
  console.log(`latency p99: ${p99.toFixed(0)} ms`)
  console.log(`latency max: ${max.toFixed(0)} ms`)

  console.log('')
  console.log('── SLO check ──')
  let slo_ok = true
  if (errPct > SLO_ERROR_PCT) {
    console.log(`✗ error rate ${errPct.toFixed(2)}% exceeds SLO ${SLO_ERROR_PCT}%`)
    slo_ok = false
  } else {
    console.log(`✓ error rate within SLO (${errPct.toFixed(2)}% ≤ ${SLO_ERROR_PCT}%)`)
  }
  if (p95 > SLO_P95_MS) {
    console.log(`✗ p95 latency ${p95.toFixed(0)}ms exceeds SLO ${SLO_P95_MS}ms`)
    slo_ok = false
  } else {
    console.log(`✓ p95 within SLO (${p95.toFixed(0)} ≤ ${SLO_P95_MS}ms)`)
  }

  console.log('')
  console.log('── Ledger consistency ──')
  const lc = await ledgerConsistency()
  if (DB_URL) {
    if (lc.ok) {
      console.log(`✓ debits = credits across ${lc.entries} order JEs`)
    } else {
      console.log(`✗ ledger off by ${lc.delta} cents across ${lc.entries} order JEs`)
      slo_ok = false
    }
  } else {
    console.log('skipped (set ADMIN_DB_URL or DATABASE_URL to enable)')
  }

  process.exit(slo_ok ? 0 : 2)
}

void main().catch((err) => { console.error(err); process.exit(1) })
