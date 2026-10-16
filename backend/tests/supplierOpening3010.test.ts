// H49 (the CA, 2026-10-16): a supplier's opening balance is offset on 3010
// Owner's capital — the same as opening stock — not 3020. Entries already
// posted to 3020 stay as they are (a reclass is a manual journal); a reduction
// unwinds 3010 first, then the legacy 3020, so a company move never leaves one
// equity account up and the other down. Dating and the refused-posting flag
// are unchanged (wave 1). Two companies: nothing reaches company B unless the
// supplier moves there.
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import {
  OPENING_OFFSET_CODE, LEGACY_OPENING_OFFSET_CODE, OPENING_SOURCE_TYPE,
  syncSupplierOpeningBalance, syncOpeningBalanceOrFlag,
} from '../src/modules/procurement/openingBalance.js'
import { toCents } from '../src/lib/money.js'

let A: string
let B: string
const RUN = randomUUID().slice(0, 6)

async function net(tenantId: string, code: string, supplierId: string): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: { account: { code }, journalEntry: { tenantId, reference: { startsWith: `${OPENING_SOURCE_TYPE}:${supplierId}:` } } },
    select: { type: true, amountCents: true },
  })
  return lines.reduce((t, l) => t + (l.type === 'debit' ? toCents(l.amountCents) : -toCents(l.amountCents)), 0)
}

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: `H49 A ${RUN}`, slug: `h49-a-${RUN}` } })).id
  B = (await prisma.tenant.create({ data: { name: `H49 B ${RUN}`, slug: `h49-b-${RUN}` } })).id
  await ensureChartOfAccounts(A)
  await ensureChartOfAccounts(B)
})

describe('supplier opening balance offset (H49)', () => {
  it('the offset is 3010 Owner\'s capital; 3020 is kept only as the legacy code', () => {
    expect(OPENING_OFFSET_CODE).toBe('3010')
    expect(LEGACY_OPENING_OFFSET_CODE).toBe('3020')
  })

  it('a new opening balance posts Dr 3010 / Cr 2010 in its own company, dated at the opening date; company B untouched', async () => {
    const date = new Date('2026-09-01T00:00:00Z') // a DATE column
    const s = await prisma.supplier.create({ data: { name: `New ${RUN}`, tenantId: A, openingBalanceCents: 40_000, openingBalanceDate: date } })
    const r = await syncSupplierOpeningBalance(s.id)
    expect(r.postings).toHaveLength(1)
    expect(await net(A, '3010', s.id)).toBe(40_000)
    expect(await net(A, '2010', s.id)).toBe(-40_000)
    expect(await net(A, '3020', s.id)).toBe(0)
    const e = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.postings[0]!.entryId }, select: { entryDate: true, tenantId: true } })
    expect(e.tenantId).toBe(A)
    expect(e.entryDate.toISOString()).toBe(date.toISOString())
    expect(await prisma.journalEntry.count({ where: { tenantId: B, reference: { startsWith: `${OPENING_SOURCE_TYPE}:${s.id}:` } } })).toBe(0)
    // Replay posts nothing.
    expect((await syncSupplierOpeningBalance(s.id)).postings).toEqual([])
  })

  it('a legacy 3020 posting stays; an increase goes to 3010; a reduction unwinds 3010 first, then 3020', async () => {
    const s = await prisma.supplier.create({ data: { name: `Legacy ${RUN}`, tenantId: A, openingBalanceCents: 10_000 } })
    // What wave 1 posted before H49: Dr 3020 / Cr 2010.
    await postJournalEntry({
      tenantId: A, sourceType: OPENING_SOURCE_TYPE, sourceId: `${s.id}:${randomUUID()}`, description: 'legacy opening',
      entryDate: new Date(), postedBy: 'system',
      lines: [{ accountCode: '3020', type: 'debit', amountCents: 10_000 }, { accountCode: '2010', type: 'credit', amountCents: 10_000 }],
    })
    expect((await syncSupplierOpeningBalance(s.id)).postings).toEqual([]) // left as it is
    expect(await net(A, '3020', s.id)).toBe(10_000)

    await prisma.supplier.update({ where: { id: s.id }, data: { openingBalanceCents: 15_000 } })
    await syncSupplierOpeningBalance(s.id)
    expect(await net(A, '3010', s.id)).toBe(5_000)
    expect(await net(A, '3020', s.id)).toBe(10_000)

    await prisma.supplier.update({ where: { id: s.id }, data: { openingBalanceCents: 8_000 } })
    await syncSupplierOpeningBalance(s.id)
    expect(await net(A, '3010', s.id)).toBe(0)
    expect(await net(A, '3020', s.id)).toBe(8_000)
    expect(await net(A, '2010', s.id)).toBe(-8_000)

    // Moving to company B: A unwinds to zero on BOTH equity accounts, B posts on 3010.
    await prisma.supplier.update({ where: { id: s.id }, data: { tenantId: B } })
    await syncSupplierOpeningBalance(s.id)
    for (const code of ['3010', '3020', '2010']) expect(await net(A, code, s.id)).toBe(0)
    expect(await net(B, '3010', s.id)).toBe(8_000)
    expect(await net(B, '3020', s.id)).toBe(0)
    expect(await net(B, '2010', s.id)).toBe(-8_000)
  })

  it('every 3010 / 2010 line sits on the SUPPLIER\'s own company chart account (never another company\'s)', async () => {
    const s = await prisma.supplier.create({ data: { name: `Chart ${RUN}`, tenantId: A, openingBalanceCents: 7_000 } })
    await syncSupplierOpeningBalance(s.id)
    await prisma.supplier.update({ where: { id: s.id }, data: { tenantId: B } })
    await syncSupplierOpeningBalance(s.id)
    const lines = await prisma.journalLine.findMany({
      where: { journalEntry: { reference: { startsWith: `${OPENING_SOURCE_TYPE}:${s.id}:` } } },
      select: { account: { select: { code: true, tenantId: true } }, journalEntry: { select: { tenantId: true } } },
    })
    expect(lines.length).toBe(6) // A: post + unwind, B: post — two lines each
    for (const l of lines) {
      expect(['3010', '2010']).toContain(l.account.code)
      expect(l.account.tenantId).toBe(l.journalEntry.tenantId)
    }
    expect(await net(B, '3010', s.id)).toBe(7_000)
  })

  it('a refused posting (closed month) still flags posting_failed with its document date', async () => {
    const date = new Date('2026-08-10T00:00:00Z') // a DATE column
    await prisma.periodLock.create({ data: { tenantId: B, lockedThrough: new Date('2026-08-31T23:59:59+05:00'), lockedBy: 'test' } })
    const s = await prisma.supplier.create({ data: { name: `Closed ${RUN}`, tenantId: B, openingBalanceCents: 3_000, openingBalanceDate: date } })
    const r = await syncOpeningBalanceOrFlag(s.id)
    expect(r.ok).toBe(false)
    const flag = await prisma.exceptionFlag.findFirst({ where: { tenantId: B, kind: 'posting_failed', entityId: s.id } })
    expect(flag).not.toBeNull()
    expect((flag!.metadata as { documentDate?: string }).documentDate).toBe(date.toISOString())
    expect(await prisma.exceptionFlag.count({ where: { tenantId: A, entityId: s.id } })).toBe(0)
  })
})
