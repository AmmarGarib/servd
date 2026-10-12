// One-off drain of servd's OLD direct FBR / SRB filing queues (spec §9.4, D6).
// Runs once at boot (W4 wires it before the workers start) in the release
// that switches filing to the POS connector, so a deployed image never has
// both filers. Remove one release later.
//
//   1. For each of `fbr-submission` and `srb-submission`: pause, collect the
//      orderIds of waiting / delayed / active / failed jobs, obliterate.
//   2. Delete the cached PRAL token (`fbr:auth_token`).
//   3. Orders from those jobs that were never filed (no fbr/srb number, no
//      sale document) get a sale document forced to held / legacy_unfiled —
//      visible on the POS connector page, filed when the CEO releases.
//   4. Pending SRB sales-return jobs (`kind: 'return'`, queued by the old
//      refundOrder with a 5-minute delay) become refund documents through
//      enqueueFiscalRefundTx (key `refund:<refundRef>`): against a sale filed
//      directly → manual_required / prefiled_direct_refund + the
//      fiscal_manual_refund flag (owner flag e); against a sale now held →
//      waiting, filed after it. None is silently lost (W1-R9).
//   5. Audit `fiscal.legacy_drain` with counts and up to 500 order ids.
//
// Idempotent through the global Setting `fiscal.legacyDrainedAt` — a
// DELIBERATE platform row (Setting has no company): the queues were global.
// Every step is guarded; a failure logs and never blocks boot. The flag is
// only written once the queues were really drained, so a boot with Redis down
// tries again next time.

import { Queue } from 'bullmq'
import { prisma } from '../lib/prisma.js'
import { redis } from '../lib/redis.js'
import { withTimeout } from './util.js'
import { fiscalReportingRequired, parseFiscalSettings } from './config.js'
import { buildFiscalSaleTx, payloadHash } from './fiscal/payload.js'
import { newDocumentId, enqueueFiscalRefundTx } from './fiscal/outbox.js'

export const LEGACY_DRAIN_KEY = 'fiscal.legacyDrainedAt'
const LEGACY_QUEUES = ['fbr-submission', 'srb-submission'] as const
const STEP_MS = 10_000

export interface DrainResult { ran: boolean; jobs: number; orders: number; held: number; returns: number; errors: string[] }

interface LegacyReturn { orderId: string; refundRef: string; refundAmountCents: number }

export async function drainLegacyTaxQueues(): Promise<DrainResult> {
  const result: DrainResult = { ran: false, jobs: 0, orders: 0, held: 0, returns: 0, errors: [] }
  try {
    const done = await prisma.setting.findUnique({ where: { key: LEGACY_DRAIN_KEY } })
    if (done) return result
  } catch (err) {
    console.error('[legacy-drain] could not read the drain flag:', (err as Error).message)
    return result
  }
  result.ran = true

  const orderIds = new Set<string>()
  const returns = new Map<string, LegacyReturn>()
  let queuesOk = true
  for (const name of LEGACY_QUEUES) {
    let q: Queue | null = null
    try {
      q = new Queue(name, { connection: redis })
      await withTimeout(q.pause(), STEP_MS, `${name} pause`)
      const jobs = await withTimeout(q.getJobs(['waiting', 'delayed', 'active', 'failed', 'paused', 'prioritized', 'waiting-children']), STEP_MS, `${name} list`)
      for (const j of jobs) {
        result.jobs++
        const data = (j?.data ?? {}) as { orderId?: unknown; kind?: unknown; refundRef?: unknown; refundAmountCents?: unknown }
        const id = data.orderId
        if (typeof id === 'string' && id) orderIds.add(id)
        if (typeof id === 'string' && id && data.kind === 'return' && typeof data.refundRef === 'string' && data.refundRef
          && typeof data.refundAmountCents === 'number' && Number.isInteger(data.refundAmountCents) && data.refundAmountCents > 0) {
          returns.set(`${id}:${data.refundRef}`, { orderId: id, refundRef: data.refundRef, refundAmountCents: data.refundAmountCents })
        }
      }
      await withTimeout(q.obliterate({ force: true }), STEP_MS, `${name} obliterate`)
    } catch (err) {
      queuesOk = false
      result.errors.push(`${name}: ${(err as Error).message}`)
      console.error(`[legacy-drain] ${name} failed:`, (err as Error).message)
    } finally {
      try { if (q) await withTimeout(q.close(), STEP_MS, `${name} close`) } catch { /* ignore */ }
    }
  }
  try {
    await withTimeout(redis.del('fbr:auth_token'), STEP_MS, 'del fbr:auth_token')
  } catch (err) {
    result.errors.push(`fbr:auth_token: ${(err as Error).message}`)
  }

  result.orders = orderIds.size
  const heldIds: string[] = []
  for (const orderId of orderIds) {
    try {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, fbrInvoiceNumber: true, srbInvoiceNumber: true, concept: { select: { tenantId: true } } },
      })
      const tenantId = order?.concept.tenantId
      if (!order || !tenantId || order.fbrInvoiceNumber || order.srbInvoiceNumber) continue
      if (!['completed', 'refunded'].includes(order.status)) continue
      if (!(await fiscalReportingRequired(tenantId))) continue
      const exists = await prisma.fiscalDocument.findFirst({ where: { tenantId, orderId, kind: 'sale' }, select: { id: true } })
      if (exists) continue
      const created = await prisma.$transaction(async (tx) => {
        const row = await tx.posConnector.findUnique({ where: { tenantId_kind: { tenantId, kind: 'fiscal' } }, select: { settings: true } })
        const id = newDocumentId()
        const built = await buildFiscalSaleTx(tx, orderId, id, parseFiscalSettings(row?.settings ?? {}))
        const r = await tx.fiscalDocument.createMany({
          data: [{
            id, tenantId, kind: 'sale', orderId, conceptId: built.conceptId, locationId: built.locationId,
            idempotencyKey: `sale:${orderId}`, status: 'held', statusReason: 'legacy_unfiled',
            payload: JSON.parse(JSON.stringify(built.payload)), payloadHash: payloadHash(built.payload), amountCents: built.totalCents,
          }],
          skipDuplicates: true,
        })
        return r.count > 0
      })
      if (created) { result.held++; heldIds.push(orderId) }
    } catch (err) {
      result.errors.push(`order ${orderId}: ${(err as Error).message}`)
    }
  }

  // Sales returns, after the sales (a return against a sale held above waits for it).
  const returnDocs: string[] = []
  for (const ret of returns.values()) {
    try {
      const id = await legacyReturnToDocument(ret)
      if (id) { result.returns++; returnDocs.push(id) }
    } catch (err) {
      result.errors.push(`return ${ret.orderId}: ${(err as Error).message}`)
    }
  }

  try {
    await prisma.auditLog.create({
      data: {
        category: 'system',
        tenantId: null,
        action: 'fiscal.legacy_drain',
        entity: 'Setting',
        entityId: LEGACY_DRAIN_KEY,
        metadata: {
          jobs: result.jobs, orders: result.orders, held: result.held, returns: result.returns, queuesOk,
          returnDocumentIds: returnDocs.slice(0, 500),
          orderIds: [...orderIds].slice(0, 500), heldOrderIds: heldIds.slice(0, 500), errors: result.errors.slice(0, 20),
        },
      },
    })
  } catch (err) {
    console.error('[legacy-drain] audit failed:', (err as Error).message)
  }
  if (queuesOk) {
    try {
      await prisma.setting.upsert({ where: { key: LEGACY_DRAIN_KEY }, create: { key: LEGACY_DRAIN_KEY, value: new Date().toISOString() }, update: {} })
    } catch (err) {
      console.error('[legacy-drain] could not write the drain flag:', (err as Error).message)
    }
  }
  console.info(`[legacy-drain] jobs=${result.jobs} orders=${result.orders} held=${result.held} returns=${result.returns}${result.errors.length ? ` errors=${result.errors.length}` : ''}`)
  return result
}

/**
 * One old SRB sales-return job → a refund FiscalDocument of the order's own
 * company. The refund Payment (refundRef) gives the amount and tender when it
 * is this order's; otherwise the job's figure is used.
 */
async function legacyReturnToDocument(ret: LegacyReturn): Promise<string | null> {
  const order = await prisma.order.findUnique({ where: { id: ret.orderId }, select: { id: true, concept: { select: { tenantId: true } } } })
  const tenantId = order?.concept.tenantId
  if (!order || !tenantId) return null
  const pay = await prisma.payment.findFirst({
    where: { id: ret.refundRef, orderId: order.id, status: 'refunded' },
    select: { amountCents: true, method: true },
  })
  const doc = await prisma.$transaction((tx) => enqueueFiscalRefundTx(tx, {
    orderId: order.id,
    tenantId,
    refundPaymentId: ret.refundRef,
    amountCents: pay ? Math.abs(pay.amountCents) : ret.refundAmountCents,
    reason: 'Sales return queued before the POS connector',
    method: pay?.method ?? null,
  }))
  return doc?.created ? doc.id : null
}
