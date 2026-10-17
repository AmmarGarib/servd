// Night audit cod_pending vs a BOOKED rider debt (owner, 2026-10-17: "A
// cash-on-delivery rider debt that finance has already booked stops blocking
// the night run").
//
// Two companies A and B, both with code-only delivery on. What this defends:
//   - an unbooked pending COD blocks cod_pending (and the night run);
//   - once finance books the rider debt (own rider: live 'cod.rider_debt:<pid>'
//     entry; fleet rider: posted inter-company 'cod' transfer) the day's
//     cod_pending is a warn "rider owes — booked" and the night run passes;
//   - reversing the booking makes it block again;
//   - B's booked debt never clears A's unbooked COD, and A's booking never
//     touches B's check;
//   - the month close cod_with_rider still blocks on a booked-but-pending COD.
import { describe, it, expect, beforeAll } from 'vitest'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { DELIVERY_CODE_ONLY_SETTING } = await import('../src/lib/deliveryRules.js')
const { fmtPktDate, parsePktEndOfDay } = await import('../src/modules/accounting/dates.js')
const { reverseJournalEntry } = await import('../src/modules/accounting/journal.js')
const posting = await import('../src/modules/accounting/codPosting.js')
const { nightChecklist } = await import('../src/modules/nightAudit/checks.js')
const { runNightAudit } = await import('../src/modules/nightAudit/service.js')
const { codCloseCheck } = await import('../src/modules/reconciliation/codCloseCheck.js')
const { reverseSystemTransfer } = await import('../src/modules/intercompany/service.js')

const PREFIX = `nacb-${Date.now()}`
const DAY = 86_400_000
const DAY_A = fmtPktDate(new Date(Date.now() - 3 * DAY))
const DAY_B = fmtPktDate(new Date(Date.now() - 3 * DAY))
const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+05:00`)

let A: string, B: string, brandA: string, brandB: string, riderA: string, riderB: string
let finA: { id: string; role: string; memberTenantIds: string[] }
let finB: { id: string; role: string; memberTenantIds: string[] }
let finAB: { id: string; role: string; memberTenantIds: string[] }

async function mkTenant(name: string): Promise<string> {
  const id = (await prisma.tenant.create({ data: { name, slug: `${PREFIX}-${name.toLowerCase().replace(/\s+/g, '-')}` } })).id
  await ensureChartOfAccounts(id)
  return id
}

async function mkUser(key: string, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} ${key}`, email: `${PREFIX}.${key}@nacb.test`, password: await bcrypt.hash('x-Password-1', 4),
      role: 'finance', tenantId: tenants[0]!, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((t) => ({ tenant: { connect: { id: t } }, role: 'manager' })) },
    },
  })
  return { id: u.id, role: 'finance', memberTenantIds: tenants }
}

let seq = 0
async function mkCod(conceptId: string, tenantId: string, riderId: string, day: string) {
  seq += 1
  const amount = 120_000 + seq
  const completedAt = at(day, '13:00')
  const order = await prisma.order.create({
    data: {
      conceptId, source: 'servd', fulfilmentType: 'delivery', status: 'completed', totalCents: amount,
      customerName: `Customer ${seq}`, riderId, deliveryOtpVerifiedAt: completedAt,
      placedAt: at(day, '12:30'), completedAt, deliveredAt: completedAt,
    },
  })
  const p = await prisma.payment.create({ data: { orderId: order.id, method: 'cash', amountCents: amount, status: 'pending', createdAt: at(day, '12:30') } })
  await prisma.journalEntry.create({ data: { tenantId, reference: `order.complete:${order.id}`, description: 'test sale', entryDate: completedAt } })
  return { orderId: order.id, paymentId: p.id, amount }
}

const codProblem = async (tenantId: string, day: string) =>
  (await nightChecklist(prisma, tenantId, day, 'night')).problems.find((p) => p.key === 'cod_pending') ?? null

const monthClose = (tenantId: string, day: string) => codCloseCheck.run({
  db: prisma, tenantId, prevLock: null, newLock: parsePktEndOfDay(day), months: [day.slice(0, 7)], isYearEnd: false,
})

let a1: { orderId: string; paymentId: string; amount: number }
let b1: { orderId: string; paymentId: string; amount: number }

beforeAll(async () => {
  A = await mkTenant('Nacb Alpha')
  B = await mkTenant('Nacb Beta')
  brandA = (await prisma.concept.create({ data: { name: 'Alpha N', slug: `${PREFIX}-a`, type: 'restaurant', tenantId: A } })).id
  brandB = (await prisma.concept.create({ data: { name: 'Beta N', slug: `${PREFIX}-b`, type: 'restaurant', tenantId: B } })).id
  riderA = (await prisma.rider.create({ data: { name: 'Asad', phone: `92321${Date.now() % 10_000_000}`, tenantId: A } })).id
  riderB = (await prisma.rider.create({ data: { name: 'Basit', phone: `92322${Date.now() % 10_000_000}`, tenantId: B } })).id
  finA = await mkUser('fin-a', [A])
  finB = await mkUser('fin-b', [B])
  finAB = await mkUser('fin-ab', [A, B])
  const on = new Date(Date.now() - 30 * DAY).toISOString()
  for (const t of [A, B]) await prisma.setting.create({ data: { key: `${DELIVERY_CODE_ONLY_SETTING}:${t}`, value: on } })
  a1 = await mkCod(brandA, A, riderA, DAY_A)
  b1 = await mkCod(brandB, B, riderB, DAY_B)
}, 60_000)

describe('cod_pending — booked rider debt', () => {
  it('pending, unbooked COD blocks the night run', async () => {
    const p = await codProblem(A, DAY_A)
    expect(p).toMatchObject({ key: 'cod_pending', severity: 'block', count: 1, cents: a1.amount })
    const cl = await nightChecklist(prisma, A, DAY_A, 'night')
    expect(cl.blocks.map((b) => b.key)).toContain('cod_pending')
  })

  it("B's booked debt does not clear A's unbooked COD", async () => {
    const r = await posting.bookCodRiderDebt({ paymentId: b1.paymentId, actor: finB, reason: 'rider kept the cash' })
    expect(r.entryId).toBeTruthy()
    expect((await codProblem(A, DAY_A))).toMatchObject({ severity: 'block', count: 1 })
    expect((await codProblem(B, DAY_B))).toMatchObject({ severity: 'warn', count: 1, cents: b1.amount })
  })

  it('after finance books A\'s rider debt the day passes; it shows as "rider owes — booked"', async () => {
    await posting.bookCodRiderDebt({ paymentId: a1.paymentId, actor: finA, reason: 'rider kept the cash' })
    const p = await codProblem(A, DAY_A)
    expect(p).toMatchObject({ key: 'cod_pending', severity: 'warn', overridable: false, count: 1, cents: a1.amount })
    expect(p!.detail).toContain('rider owes — booked')
    const cl = await nightChecklist(prisma, A, DAY_A, 'night')
    expect(cl.blocks.map((b) => b.key)).not.toContain('cod_pending')
    expect(cl.warnings.map((b) => b.key)).toContain('cod_pending')
  })

  it('the night run itself passes for that day', async () => {
    await runNightAudit({ tenantId: A, day: DAY_A, actor: { id: finA.id, role: 'finance' } as never })
    const row = await prisma.nightAuditDay.findUniqueOrThrow({ where: { tenantId_businessDate: { tenantId: A, businessDate: DAY_A } } })
    expect(row.status).not.toBe('open')
    expect(row.nightOverrides).toBeNull()
  })

  it('the month close cod_with_rider still blocks on the booked, pending COD', async () => {
    const r = await monthClose(A, DAY_A)
    expect(r).toMatchObject({ key: 'cod_with_rider', severity: 'block', count: 1, cents: a1.amount })
  })

  it('reversing the booked debt blocks again', async () => {
    await reverseJournalEntry(A, posting.COD_DEBT_SOURCE, a1.paymentId, 'booked in error', { postedBy: 'system' })
    const p = await codProblem(A, DAY_A)
    expect(p).toMatchObject({ severity: 'block', count: 1, cents: a1.amount })
    // B is untouched by A's reversal.
    expect((await codProblem(B, DAY_B))).toMatchObject({ severity: 'warn', count: 1 })
  })

  it('a fleet rider: the posted inter-company cod transfer counts as booked; reversing it blocks again', async () => {
    const day = fmtPktDate(new Date(Date.now() - 5 * DAY))
    const fleet = await mkCod(brandA, A, riderB, day) // B's rider on A's order
    expect((await codProblem(A, day))).toMatchObject({ severity: 'block', count: 1 })
    const r = await posting.bookCodRiderDebt({ paymentId: fleet.paymentId, actor: finAB, reason: 'fleet rider kept it' })
    expect(r.transferId).toBeTruthy()
    expect((await codProblem(A, day))).toMatchObject({ severity: 'warn', count: 1, cents: fleet.amount })
    // B (the rider's company) has no COD of its own that day.
    expect(await codProblem(B, day)).toBeNull()
    await reverseSystemTransfer(r.transferId!, 'booked in error')
    expect((await codProblem(A, day))).toMatchObject({ severity: 'block', count: 1 })
    expect((await monthClose(A, day))).toMatchObject({ key: 'cod_with_rider', severity: 'block' })
  })
})
