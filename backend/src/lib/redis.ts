import { Redis } from 'ioredis'

const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379'

// TLS certificate validation is ON by default — disabling it silently allows
// MITM of session/rate-limit/queue traffic. If the Redis host genuinely uses a
// self-signed cert, opt out explicitly with REDIS_TLS_INSECURE=1 (and know why).
const tlsOptions = redisUrl.startsWith('rediss://')
  ? { tls: { rejectUnauthorized: process.env['REDIS_TLS_INSECURE'] !== '1' } }
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

// A connection that FAILS instead of waiting.
//
// The three above carry `maxRetriesPerRequest: null` because BullMQ requires
// it. The side effect is that a command issued while Redis is down never
// rejects — ioredis parks it in the offline queue and retries forever. For a
// background job that is what you want. On the login path it is not: the
// request hangs until the client gives up, and any code that meant to catch a
// Redis error and fall back never gets the chance, because no error is ever
// thrown.
//
// So the login rate limiter uses this connection instead. `enableOfflineQueue:
// false` makes a command reject immediately when the socket is down, and one
// retry keeps a momentary blip from being treated as an outage. Use it for
// anything on a request path where a stalled Redis must degrade rather than
// block.
// Note: NOT lazyConnect. With the offline queue disabled, a command issued
// before the socket is up rejects rather than waiting for it, so this
// connection is opened eagerly at import and is ready long before the first
// login arrives.
export const redisFast = new Redis(redisUrl, {
  ...baseOpts,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  // A much tighter reconnect than the shared clients use. Their backoff climbs
  // to a 30s ceiling, which is sensible for a job queue and wrong here: with
  // the offline queue disabled, every second this socket stays down is a second
  // of login rate limiting running on the weaker in-memory fallback and a
  // second of /health reporting red. Measured: with the 30s ceiling this
  // connection was still refusing commands ten seconds after Redis came back.
  // Cap at 2s so recovery tracks the server, not the backoff curve.
  retryStrategy: (times: number) => Math.min(100 * 2 ** times, 2_000),
})

redis.on('error',     makeThrottledLogger('Redis'))
redisSub.on('error',  makeThrottledLogger('Redis/sub'))
redisPub.on('error',  makeThrottledLogger('Redis/pub'))
redisFast.on('error', makeThrottledLogger('Redis/fast'))
