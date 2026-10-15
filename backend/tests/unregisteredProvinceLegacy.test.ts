// A brand saved before PRA / KPRA / BRA were removed (owner, 2026-10-15) may
// still be set to Punjab, KP or Balochistan — possibly a deleted brand, which
// no screen can edit. Such a brand must not break its company's sales tax
// return (it is named in the notes), and a refund of a sale whose tax still
// sits on the account it was booked to still finds that account. New postings
// for it keep refusing (422 PROVINCE_NOT_REGISTERED).
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma, mkCompany, type Company } from './connectorsFixtures.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { salesTaxReturn } from '../src/modules/accounting/salesTaxReturn.js'
import { refundTaxAccountFor } from '../src/modules/accounting/orderPosting.js'
import { parsePktStartOfDay, parsePktEndOfDay } from '../src/modules/accounting/dates.js'

const stamp = Date.now()
let A: Company
let legacyId: string

beforeAll(async () => {
  A = await mkCompany(`upl-${stamp}`)
  legacyId = (await prisma.concept.create({
    data: {
      name: `Lahore Legacy ${stamp}`, slug: `upl-lahore-${stamp}`, type: 'restaurant', tenantId: A.tenantId,
      taxRate: 17, taxRateCash: 16, taxRateCard: 5, province: 'PB', deletedAt: new Date(),
    },
  })).id
}, 60_000)

describe('a legacy brand set to PB / KP / BL', () => {
  it('does not break the company\'s sales tax return; the notes name it', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const r = await salesTaxReturn(A.tenantId, parsePktStartOfDay(today), parsePktEndOfDay(today))
    expect(r.notes.some((n) => n.includes(`Lahore Legacy ${stamp}`))).toBe(true)
    const srb = r.byAuthority.find((a) => a.key === 'srb')!
    expect(srb.brands).toContain(`brand-upl-${stamp}`)
    expect(r.byAuthority.flatMap((a) => a.brands)).not.toContain(`upl-lahore-${stamp}`)
  })

  it('a refund finds the account the sale credited while it still holds the tax; else refuses', async () => {
    await postJournalEntry({
      tenantId: A.tenantId, sourceType: 'manual', sourceId: randomUUID(), description: 'legacy sale tax', postedBy: 'test', entryDate: new Date(),
      lines: [
        { accountCode: '1010', type: 'debit', amountCents: 1_600, conceptId: legacyId },
        { accountCode: '2032', type: 'credit', amountCents: 1_600, conceptId: legacyId },
      ],
    })
    const order = { conceptId: legacyId, concept: { province: 'PB', srbPosId: null } }
    expect(await refundTaxAccountFor(prisma, A.tenantId, order, '2032', 1_000)).toBe('2032')
    await expect(refundTaxAccountFor(prisma, A.tenantId, order, '2032', 5_000)).rejects.toMatchObject({ code: 'PROVINCE_NOT_REGISTERED' })
    await expect(refundTaxAccountFor(prisma, A.tenantId, order, null, 1_000)).rejects.toMatchObject({ code: 'PROVINCE_NOT_REGISTERED' })
  })
})
