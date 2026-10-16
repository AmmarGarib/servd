// Closed books are the CEO's (owner, 2026-10-16; accounting/closedBooks.ts):
//   - a closed month refuses every posting (unchanged);
//   - a month the CEO reopened takes postings from the CEO only until it is
//     closed again (automatic 'system' postings keep their own rules);
//   - cancelling / reversing an entry dated in closed or reopened books is the
//     CEO's only; open months work as before for finance.
import { describe, it, expect, beforeAll } from 'vitest'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { postJournalEntry, reverseJournalEntry } = await import('../src/modules/accounting/journal.js')
const { rememberReopened, forgetReopened } = await import('../src/modules/accounting/closedBooks.js')

const P = `cb${Date.now()}`
let T = ''
let ceo = ''
let fin = ''
const lines = [
  { accountCode: '6140', type: 'debit' as const, amountCents: 10_000 },
  { accountCode: '1010', type: 'credit' as const, amountCents: 10_000 },
]
const sept = new Date('2026-09-15T07:00:00Z')
const oct = new Date('2026-10-10T07:00:00Z')
const post = (id: string, entryDate: Date, postedBy: string) =>
  postJournalEntry({ tenantId: T, sourceType: 'manual', sourceId: `${P}-${id}`, description: id, entryDate, postedBy, lines })

beforeAll(async () => {
  T = (await prisma.tenant.create({ data: { name: `${P} Co`, slug: P } })).id
  await ensureChartOfAccounts(T)
  ceo = (await prisma.user.create({ data: { name: 'CEO', email: `${P}.ceo@x.pk`, password: 'x', role: 'admin', tenantId: T } })).id
  fin = (await prisma.user.create({ data: { name: 'Fin', email: `${P}.fin@x.pk`, password: 'x', role: 'finance', tenantId: T } })).id
  await post('sept-before-close', sept, fin)
})

describe('closed books', () => {
  it('a closed month refuses postings; reversing its entries is the CEO\'s', async () => {
    await prisma.periodLock.create({ data: { tenantId: T, lockedThrough: new Date('2026-09-30T18:59:59Z'), lockedBy: ceo } })
    await expect(post('sept-closed', sept, ceo)).rejects.toMatchObject({ code: 'PERIOD_LOCKED' })
    await expect(reverseJournalEntry(T, 'manual', `${P}-sept-before-close`, 'wrong', { postedBy: fin, entryDate: oct }))
      .rejects.toMatchObject({ code: 'CEO_ONLY_CLOSED_BOOKS', statusCode: 403 })
    const r = await reverseJournalEntry(T, 'manual', `${P}-sept-before-close`, 'wrong', { postedBy: ceo, entryDate: oct })
    expect(r.posted).toBe(true)
  })

  it('open months work as before for finance', async () => {
    const r = await post('oct-open', oct, fin)
    expect(r.posted).toBe(true)
    const rev = await reverseJournalEntry(T, 'manual', `${P}-oct-open`, 'typo', { postedBy: fin, entryDate: oct })
    expect(rev.posted).toBe(true)
  })

  it('a reopened month takes postings from the CEO only until it is closed again', async () => {
    const lock = await prisma.periodLock.findFirstOrThrow({ where: { tenantId: T } })
    await prisma.$transaction(async (tx) => {
      await tx.periodLock.delete({ where: { id: lock.id } })
      await rememberReopened(tx, T, lock.lockedThrough)
    })
    await expect(post('sept-reopened-fin', sept, fin)).rejects.toMatchObject({ code: 'CEO_ONLY_CLOSED_BOOKS' })
    expect((await post('sept-reopened-ceo', sept, ceo)).posted).toBe(true)
    expect((await post('sept-reopened-system', sept, 'system')).posted).toBe(true)
    await expect(reverseJournalEntry(T, 'manual', `${P}-sept-reopened-ceo`, 'x', { postedBy: fin, entryDate: oct }))
      .rejects.toMatchObject({ code: 'CEO_ONLY_CLOSED_BOOKS' })
    // Closed again: the window is forgotten; September refuses everyone again.
    await prisma.$transaction(async (tx) => {
      await forgetReopened(tx, T, lock.lockedThrough)
      await tx.periodLock.create({ data: { tenantId: T, lockedThrough: lock.lockedThrough, lockedBy: ceo } })
    })
    await expect(post('sept-again', sept, ceo)).rejects.toMatchObject({ code: 'PERIOD_LOCKED' })
    expect((await post('oct-after', oct, fin)).posted).toBe(true)
  })
})
