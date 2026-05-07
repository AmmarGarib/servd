// BullMQ Worker — Order Ingestion
// Processes queued Foodpanda orders with retry + exponential backoff

import { Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { ingestOrder } from '../modules/orders/service.js'
import { normaliseFoodpandaOrder } from '../adapters/foodpanda/index.js'
import { normaliseCareemOrder } from '../adapters/careem/index.js'
import { prisma } from '../lib/prisma.js'

async function getConceptId(storeKey: string): Promise<string> {
  const setting = await prisma.setting.findUnique({ where: { key: storeKey } })
  if (!setting?.value) throw new Error(`No concept mapped for key: ${storeKey}`)
  return setting.value
}

export function startOrderIngestionWorker() {
  try {
  const worker = new Worker(
    'order-ingestion',
    async (job) => {
      const { source, payload } = job.data as { source: string; payload: unknown }

      console.info(`[Worker] Processing ${source} order, attempt ${job.attemptsMade + 1}`)

      let dto
      if (source === 'foodpanda') {
        const p = payload as { order?: { vendor_code?: string } }
        const vendorCode = p.order?.vendor_code ?? 'default'
        const conceptId = await getConceptId(`foodpanda_vendor_${vendorCode}`)
        dto = normaliseFoodpandaOrder(payload as never, conceptId)
      } else if (source === 'careem') {
        const p = payload as { order?: { vendor_id?: string } }
        const vendorId = p.order?.vendor_id ?? 'default'
        const conceptId = await getConceptId(`careem_vendor_${vendorId}`)
        dto = normaliseCareemOrder(payload as never, conceptId)
      } else {
        throw new Error(`Unknown source: ${source}`)
      }

      if (!dto) {
        console.info(`[Worker] Skipped non-order event for ${source}`)
        return { skipped: true }
      }

      const result = await ingestOrder(dto)
      console.info(`[Worker] Order ingested: ${result.order.id} (created: ${result.created})`)
      return { orderId: result.order.id, created: result.created }
    },
    {
      connection: redis,
      concurrency: 5,
    },
  )

  worker.on('completed', (job, result) => {
    console.info(`[Worker] Job ${job.id} completed:`, result)
  })

  worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed after ${job?.attemptsMade} attempts:`, err.message)
  })

  worker.on('error', (err) => {
    console.error('[Worker] Worker error:', err.message)
  })

  console.info('[Worker] Order ingestion worker started')
  return worker
  } catch (err) {
    console.warn('[Worker] Order ingestion worker disabled (Redis unavailable):', (err as Error).message)
    return null
  }
}
