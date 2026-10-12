// W1-R2 — the REAL BullMQ fast path (no mocked kicker). `attempts` goes back
// down when a send finds the connector off (→ held), so a later kick reuses
// the jobId of a job that already ran. BullMQ ignores an add whose jobId still
// exists, so a kept finished job would swallow the release's kick and the
// document would sit in pending. Finished jobs are removed at once now.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Worker } from 'bullmq'
import { prisma, mkCompany, mkOrder, setConnector, resetConnectorCache, type Company } from './connectorsFixtures.js'
import { redis } from '../src/lib/redis.js'
import { getFiscalQueue, type FiscalConnectorJob } from '../src/lib/queue.js'
import { enqueueFiscalSaleTx, kickFiscal, releaseHeld, sendFiscalDocument, setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { clearConnectorCache } from '../src/connectors/registry.js'

let co: Company
let worker: Worker<FiscalConnectorJob>
const KHEER = (c: Company) => [{ menuItemId: c.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000 }]
const doc = (id: string) => prisma.fiscalDocument.findUniqueOrThrow({ where: { id } })

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

beforeAll(async () => {
  setFiscalKicker(null) // the real BullMQ add
  co = await mkCompany('queue-a', { srbPosId: 991 })
  await setConnector(co.tenantId, 'fiscal', { driver: 'test', enabled: true, liveSince: new Date(), settings: { test: { scenario: 'ok' } } })
  const q = getFiscalQueue()!
  await q.obliterate({ force: true })
  worker = new Worker<FiscalConnectorJob>('fiscal-connector', async (job) => { await sendFiscalDocument(job.data.documentId, 'worker', 15_000) }, { connection: redis, concurrency: 1 })
}, 60_000)

afterAll(async () => {
  await worker.close()
  await getFiscalQueue()?.obliterate({ force: true })
  resetConnectorCache()
})

describe('fiscal fast path with the real queue', () => {
  it('switched off while pending → held (attempts back to 0); go live + release → the SAME job slot is sent again and filed', async () => {
    const orderId = await mkOrder(co, { items: KHEER(co), taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, payments: [{ method: 'cash', amountCents: 126_500 }] })
    const created = await prisma.$transaction((tx) => enqueueFiscalSaleTx(tx, { orderId, tenantId: co.tenantId }))
    const id = created!.id
    expect(created!.status).toBe('pending')

    // 1. The CEO switches the fiscal POS off before the job runs.
    await setConnector(co.tenantId, 'fiscal', { enabled: false })
    clearConnectorCache()
    expect(await kickFiscal(id, 0)).toBe(true)
    await until('held', async () => (await doc(id)).status === 'held')
    expect(await doc(id)).toMatchObject({ status: 'held', statusReason: 'no_connector', attempts: 0 })
    // The finished job is gone, so the slot `fiscal-<id>-0` can be used again.
    await until('job removed', async () => !(await getFiscalQueue()!.getJob(`fiscal-${id}-0`)))

    // 2. Live again; release kicks fiscal-<id>-0 a second time — it must run.
    await setConnector(co.tenantId, 'fiscal', { enabled: true })
    clearConnectorCache()
    expect(await releaseHeld(co.tenantId)).toMatchObject({ released: 1 })
    const filed = await until('filed', async () => { const d = await doc(id); return d.status === 'filed' ? d : null })
    expect(filed.fiscalNumber).toMatch(/^TEST-SRB-/)
    expect(filed.attempts).toBe(1)
  }, 30_000)

  it('a kick while the same slot is still waiting is deduplicated (one job)', async () => {
    const q = getFiscalQueue()!
    await worker.pause()
    await kickFiscal('dup-doc', 3)
    await kickFiscal('dup-doc', 3)
    const jobs = (await q.getJobs(['waiting', 'paused', 'prioritized'])).filter((j) => j?.data.documentId === 'dup-doc')
    expect(jobs).toHaveLength(1)
    await q.remove(`fiscal-dup-doc-3`)
    worker.resume()
  })
})
