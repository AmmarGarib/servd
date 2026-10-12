// BOOKS-06 — the money boundary under RLS_ENFORCE=1.
//
// With RLS enforced, every model operation inside a request context runs
// wrapped in a transaction that first SETs the session vars, and
// $transaction is overridden to delegate to the base client. The money
// boundary (lib/money.ts) sits on that base client, UNDER the RLS extension,
// so bare operations, $transaction(fn) and $transaction([...]) must all still
// hand back BIGINT money as JS numbers.
//
// RLS_ENFORCE is read when lib/prisma.ts is first imported; vitest isolates
// modules per file, so set it before the dynamic import.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll } from 'vitest'

process.env.RLS_ENFORCE = '1'

type Prisma = typeof import('../src/lib/prisma.js')['prisma']
let prisma: Prisma
let runWithRlsContext: typeof import('../src/lib/rlsContext.js')['runWithRlsContext']
let tenantA: string
let entryId: string
const AMT = 3_000_000_000

beforeAll(async () => {
  ;({ prisma } = await import('../src/lib/prisma.js'))
  ;({ runWithRlsContext } = await import('../src/lib/rlsContext.js'))
  const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
  const { postJournalEntry } = await import('../src/modules/accounting/journal.js')
  const run = Math.random().toString(36).slice(2, 8)
  tenantA = (await prisma.tenant.create({ data: { name: 'RLS bigint', slug: `rls-bigint-${run}` } })).id
  await ensureChartOfAccounts(tenantA)
  entryId = (await postJournalEntry({
    tenantId: tenantA, sourceType: 'test.rls', sourceId: run, description: 'rls',
    lines: [
      { accountCode: '1020', type: 'debit',  amountCents: AMT },
      { accountCode: '3010', type: 'credit', amountCents: AMT },
    ],
  })).entryId!
}, 60_000)

describe('the money boundary with RLS enforced', () => {
  it('bare operations, $transaction(fn) and $transaction([...]) inside an RLS context return numbers', async () => {
    await runWithRlsContext({ tenantIds: [tenantA] }, async () => {
      const bare = await prisma.journalLine.findMany({ where: { journalEntryId: entryId } })
      expect(bare).toHaveLength(2)
      bare.forEach((l) => expect(l.amountCents).toBe(AMT))
      const agg = await prisma.journalLine.aggregate({ where: { journalEntryId: entryId }, _sum: { amountCents: true } })
      expect(agg._sum.amountCents).toBe(2 * AMT)

      const viaFn = await prisma.$transaction(async (tx) => tx.journalEntry.findUniqueOrThrow({ where: { id: entryId }, include: { lines: true } }))
      viaFn.lines.forEach((l) => expect(l.amountCents).toBe(AMT))

      const [rows, grp] = await prisma.$transaction([
        prisma.journalLine.findMany({ where: { journalEntryId: entryId } }),
        prisma.journalLine.groupBy({ by: ['type'], where: { journalEntryId: entryId }, _sum: { amountCents: true } }),
      ])
      rows.forEach((l) => expect(typeof l.amountCents).toBe('number'))
      grp.forEach((g) => expect(g._sum.amountCents).toBe(AMT))
    })
  })

  it('outside a context (service mode) too', async () => {
    const line = await prisma.journalLine.findFirstOrThrow({ where: { journalEntryId: entryId } })
    expect(line.amountCents).toBe(AMT)
  })
})
