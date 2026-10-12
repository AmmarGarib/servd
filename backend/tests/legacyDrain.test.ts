// W1 — the one-off drain of the old direct FBR / SRB queues (spec §9.4).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Queue } from 'bullmq'
import { prisma, mkCompany, mkOrder, type Company } from './connectorsFixtures.js'
import { redis } from '../src/lib/redis.js'
import { drainLegacyTaxQueues, LEGACY_DRAIN_KEY } from '../src/connectors/legacyDrain.js'

let A: Company
let unfiled: string, prefiled: string, notCompleted: string, unfiledRefundId: string
const KHEER = (c: Company) => [{ menuItemId: c.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000 }]

beforeAll(async () => {
  A = await mkCompany('drain-a', { srbPosId: 31 })
  unfiled = await mkOrder(A, { items: KHEER(A), taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, payments: [{ method: 'cash', amountCents: 126_500 }] })
  prefiled = await mkOrder(A, { items: KHEER(A), taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, payments: [{ method: 'cash', amountCents: 126_500 }], srbInvoiceNumber: 'SRB-DONE-1' })
  notCompleted = await mkOrder(A, { items: KHEER(A), taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, status: 'received' })
  // A cash refund on the unfiled sale whose SRB return was still queued (5-minute delay).
  unfiledRefundId = (await prisma.payment.create({ data: { orderId: unfiled, method: 'cash', amountCents: -20_000, status: 'refunded', processedAt: new Date() } })).id
  const fbr = new Queue('fbr-submission', { connection: redis })
  const srb = new Queue('srb-submission', { connection: redis })
  await fbr.obliterate({ force: true })
  await srb.obliterate({ force: true })
  await fbr.add('submit', { orderId: unfiled })
  await fbr.add('submit', { orderId: notCompleted }, { delay: 60_000 })
  await srb.add('submit', { orderId: unfiled })
  await srb.add('submit', { orderId: prefiled, kind: 'return', refundAmountCents: 1000, refundRef: 'x' }, { delay: 300_000 })
  await srb.add('submit', { orderId: unfiled, kind: 'return', refundAmountCents: 20_000, refundRef: unfiledRefundId }, { delay: 300_000 })
  await redis.set('fbr:auth_token', 'stale-token')
  await fbr.close()
  await srb.close()
}, 60_000)

afterAll(async () => {
  await prisma.setting.deleteMany({ where: { key: LEGACY_DRAIN_KEY } })
})

describe('drainLegacyTaxQueues', () => {
  it('obliterates both queues, drops the PRAL token, holds unfiled sales as legacy_unfiled, keeps queued returns, audits', async () => {
    const r = await drainLegacyTaxQueues()
    expect(r).toMatchObject({ ran: true, jobs: 5, orders: 3, held: 1, returns: 2, errors: [] })
    for (const name of ['fbr-submission', 'srb-submission']) {
      const q = new Queue(name, { connection: redis })
      const counts = await q.getJobCounts('waiting', 'delayed', 'active', 'failed', 'paused', 'completed')
      expect(Object.values(counts).reduce((s, x) => s + x, 0), name).toBe(0)
      await q.close()
    }
    expect(await redis.get('fbr:auth_token')).toBeNull()
    const sales = await prisma.fiscalDocument.findMany({ where: { orderId: { in: [unfiled, prefiled, notCompleted] }, kind: 'sale' } })
    expect(sales).toHaveLength(1)
    expect(sales[0]).toMatchObject({ orderId: unfiled, tenantId: A.tenantId, status: 'held', statusReason: 'legacy_unfiled', kind: 'sale', idempotencyKey: `sale:${unfiled}` })
    // W1-R9: a queued SRB return is never silently lost.
    // Against a sale filed directly → filed by hand (owner flag e), with the flag.
    const manual = await prisma.fiscalDocument.findFirstOrThrow({ where: { orderId: prefiled, kind: 'refund' } })
    expect(manual).toMatchObject({ tenantId: A.tenantId, idempotencyKey: 'refund:x', status: 'manual_required', statusReason: 'prefiled_direct_refund', amountCents: 1000 })
    expect((manual.payload as { original?: unknown }).original).toMatchObject({ fiscalNumber: 'SRB-DONE-1', authority: 'srb' })
    expect(await prisma.exceptionFlag.count({ where: { tenantId: A.tenantId, kind: 'fiscal_manual_refund', entityId: manual.id } })).toBe(1)
    // Against a sale now held → waits for it, with the refund Payment's own amount and tender.
    const waiting = await prisma.fiscalDocument.findFirstOrThrow({ where: { orderId: unfiled, kind: 'refund' } })
    expect(waiting).toMatchObject({ tenantId: A.tenantId, idempotencyKey: `refund:${unfiledRefundId}`, refundPaymentId: unfiledRefundId, status: 'waiting', saleDocumentId: sales[0]!.id, amountCents: 20_000 })
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'fiscal.legacy_drain' } })
    expect(audit.category).toBe('system')
    expect(audit.metadata).toMatchObject({ jobs: 5, orders: 3, held: 1, returns: 2, heldOrderIds: [unfiled] })
    expect(await prisma.setting.findUnique({ where: { key: LEGACY_DRAIN_KEY } })).not.toBeNull()
  })

  it('a second run is a no-op', async () => {
    const r = await drainLegacyTaxQueues()
    expect(r.ran).toBe(false)
    expect(await prisma.auditLog.count({ where: { action: 'fiscal.legacy_drain' } })).toBe(1)
    expect(await prisma.fiscalDocument.count({ where: { orderId: unfiled } })).toBe(2)
    expect(await prisma.fiscalDocument.count({ where: { orderId: prefiled } })).toBe(1)
  })
})
