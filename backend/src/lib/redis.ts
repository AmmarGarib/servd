import { Redis } from 'ioredis'

const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379'

const tlsOptions = redisUrl.startsWith('rediss://')
  ? { tls: { rejectUnauthorized: false } }
  : {}

// Exponential backoff: 200ms → 400ms → … → 30s ceiling
function retryStrategy(times: number): number {
  return Math.min(200 * 2 ** times, 30_000)
}

// Throttle error logs to at most one per 30s per connection to avoid console spam
function makeThrottledLogger(tag: string) {
  let lastLog = 0
  return (err: Error) => {
    const now = Date.now()
    if (now - lastLog > 30_000) {
      console.error(`[${tag}] error:`, err.message)
      lastLog = now
    }
  }
}

const baseOpts = {
  maxRetriesPerRequest: null, // required by BullMQ
  enableReadyCheck: false,
  retryStrategy,
  ...tlsOptions,
}

export const redis    = new Redis(redisUrl, { ...baseOpts, lazyConnect: true })
export const redisSub = new Redis(redisUrl, { ...baseOpts, lazyConnect: true })
export const redisPub = new Redis(redisUrl, { ...baseOpts, lazyConnect: true })

redis.on('error',    makeThrottledLogger('Redis'))
redisSub.on('error', makeThrottledLogger('Redis/sub'))
redisPub.on('error', makeThrottledLogger('Redis/pub'))
