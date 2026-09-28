import { Worker, type Queue } from 'bullmq'
import { redis } from '../lib/redis.js'
import { getBullQueue } from '../lib/queue.js'
import { computeAllSegments } from '../modules/crm/segmentComputation.js'

const QUEUE_NAME = 'segment-computation'

/** Lazily created BullMQ queue (bullmq driver only — never at import). */
export function getSegmentQueue(): Queue | null {
  return getBullQueue(QUEUE_NAME)
}

// The work itself; the BullMQ worker below (Docker) and the scheduler tick
// (Vercel, workers/registry.ts) both call it.
export async function runSegmentComputation(jobId?: string) {
  // Every company, every segment (modules/crm/segmentComputation.ts). The
  // lapsed segment this writes is the win-back audience (loyaltyTriggers).
  console.log(`[segments] Computing customer segments per company (job ${jobId})`)
  const results = await computeAllSegments()
  const total = results.reduce((s, r) => s + Math.max(r.count, 0), 0)
  const failed = results.filter((r) => r.count < 0).length
  console.log(`[segments] Done — ${results.length} company segments, ${total} memberships${failed ? `, ${failed} FAILED` : ''}`)
  return results
}

export function startSegmentComputationWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => runSegmentComputation(job.id),
    { connection: redis, concurrency: 1 },
  )

  worker.on('failed', (job, err) => {
    console.error(`[segments] Job ${job?.id} failed:`, err.message)
  })

  // Schedule daily computation at 3:00 AM PKT (22:00 UTC previous day)
  const queue = getSegmentQueue()
  queue?.upsertJobScheduler('daily-segment-computation', { pattern: '0 22 * * *' }, {
    name: 'compute-segments',
    data: {},
    opts: { removeOnComplete: 5, removeOnFail: 10 },
  }).catch((err: Error) => console.warn('[segments] Scheduler setup failed:', err.message))

  return worker
}
