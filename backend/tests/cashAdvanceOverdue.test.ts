// The daily receipts-overdue sweep (H3, Hasnain 2026-10-14: "expense at
// payment; receipts kept for the file"): a paid cash request past its dueBy
// with NO receipt uploaded is flagged ONCE ('cash_request_receipts_overdue',
// in the request's own company, amount = what is still open) and stamped
// overdueFlaggedAt. No money moves. Requests with a receipt, not yet due,
// settled, or legacy with no holder are never touched. Companies are looped
// whether or not they are active.
import { describe, it, expect, beforeAll } from 'vitest'
import bcrypt from 'bcryptjs'
import type { Prisma } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { runCashAdvanceOverdueOnce } from '../src/workers/cashAdvanceOverdue.js'

const P = `cao${Date.now()}`
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, string> = {}
const V: Record<string, string> = {}
const DAY = 86_400_000
const now = new Date()
let seq = 0

async function mkUser(key: string, tenantId: string) {
  U[key] = (await prisma.user.create({
    data: { name: `${P} ${key}`, email: `${P}.${key}@cao.pk`, password: await bcrypt.hash('x-Password-1', 4), role: 'boh', tenantId, isActive: true, accountStatus: 'active' },
  })).id
}
async function mkRequest(key: string, tenantId: string, data: Partial<Prisma.CashVoucherUncheckedCreateInput>) {
  seq++
  V[key] = (await prisma.cashVoucher.create({
    data: {
      tenantId, seq, number: `CV-${String(seq).padStart(5, '0')}`, voucherDate: now, payeeName: key, purpose: `Request ${key}`,
      category: 'transport', amountCents: 10_000, status: 'disbursed', preparedById: U['cookA']!, disbursedAt: new Date(now.getTime() - 40 * DAY),
      dueBy: new Date(now.getTime() - 10 * DAY), ...data,
    },
  })).id
}

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'Overdue Co A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'Overdue Co B', slug: `${P}-b`, isActive: false } })).id
  await mkUser('cookA', T.A)
  await mkUser('cookB', T.B)
  await mkRequest('late', T.A, { payeeUserId: U['cookA'], returnedCents: 1_000 })
  await mkRequest('withReceipt', T.A, { payeeUserId: U['cookA'] })
  await prisma.cashVoucherAttachment.create({
    data: { tenantId: T.A, voucherId: V['withReceipt']!, kind: 'receipt', mime: 'image/jpeg', sizeBytes: 3, data: Buffer.from([0xff, 0xd8, 0xff]), uploadedById: U['cookA']! },
  })
  await mkRequest('notDue', T.A, { payeeUserId: U['cookA'], dueBy: new Date(now.getTime() + 5 * DAY) })
  await mkRequest('legacy', T.A, { payeeUserId: null })
  await mkRequest('settled', T.A, { payeeUserId: U['cookA'], status: 'settled', settledCents: 10_000 })
  await mkRequest('lateB', T.B, { payeeUserId: U['cookB'], amountCents: 7_000 })
})

const flagsOf = (id: string) => prisma.exceptionFlag.findMany({ where: { entityType: 'CashVoucher', entityId: id } })

describe('receipts overdue: flagged once, in the request\'s company, nothing booked', () => {
  it('flags only the overdue requests with no receipt, each once; legacy rows are never touched', async () => {
    const entries = await prisma.journalEntry.count()
    const first = await runCashAdvanceOverdueOnce(now)
    expect(first.flagged).toBeGreaterThanOrEqual(2)

    const late = await flagsOf(V['late']!)
    expect(late).toHaveLength(1)
    expect(late[0]).toMatchObject({ tenantId: T.A, kind: 'cash_request_receipts_overdue', amountCents: 9_000, status: 'open' })
    const lateB = await flagsOf(V['lateB']!)
    expect(lateB).toHaveLength(1)
    expect(lateB[0]).toMatchObject({ tenantId: T.B, amountCents: 7_000 })

    for (const k of ['withReceipt', 'notDue', 'legacy', 'settled']) {
      expect(await flagsOf(V[k]!), k).toHaveLength(0)
      expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { id: V[k]! } })).overdueFlaggedAt, k).toBeNull()
    }
    const stamped = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: V['late']! } })
    expect(stamped.overdueFlaggedAt?.getTime()).toBe(now.getTime())
    // Nothing moves: still paid, no entry.
    expect(stamped.status).toBe('disbursed')
    expect(await prisma.journalEntry.count()).toBe(entries)

    // A second run flags nothing again.
    await runCashAdvanceOverdueOnce(new Date(now.getTime() + DAY))
    expect(await flagsOf(V['late']!)).toHaveLength(1)
    expect(await flagsOf(V['lateB']!)).toHaveLength(1)
  })
})
