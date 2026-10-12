// Probes used by GET /health (src/index.ts). Kept out of index.ts — which
// starts the server on import — so they can be tested on their own.
import type { Redis } from 'ioredis'

const SENTINEL_KEY = 'servd:health:sentinel'

/**
 * Prove the Redis connection can serve commands in the database it was
 * configured for (ONL-R2-08).
 *
 * A bare PING is not enough: with an out-of-range DB index in REDIS_URL
 * (redis://host:6379/24 on a 16-database server) ioredis's connect-time SELECT
 * fails, the socket silently stays on db 0, and PING / GET keep answering —
 * while BullMQ's own connections, which re-SELECT on connect, fail every
 * command with "ERR DB index is out of range". So:
 *   1. re-issue the SELECT this client was configured with (a no-op when it is
 *      valid — the same index the connection already has), and
 *   2. read a sentinel key (any value, including none, is fine),
 * all under `timeoutMs`, so a wedged server reports an error instead of
 * hanging /health. Pass the `redisFast` client (offline queue disabled), never
 * the shared BullMQ one whose commands wait forever while Redis is down.
 */
export async function redisHealthProbe(client: Redis, timeoutMs = 1_500): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis did not answer within ${timeoutMs} ms`)), timeoutMs)
  })
  try {
    await Promise.race([
      (async () => {
        const db = Number(client.options.db ?? 0)
        await client.select(db)
        await client.get(SENTINEL_KEY)
      })(),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export type HealthLevel = 'ok' | 'warn' | 'error'

/**
 * /health `staffCodeLogin`: can floor staff (cashier, server, kitchen — no
 * password, a code is their whole credential) sign in?
 *
 * Without WhatsApp the code cannot be SENT, but it is not an outage any more:
 * a manager hands the code over in person (POST /auth/staff/:id/sign-in-code,
 * "Sign-in code" on Workforce) and it is redeemed at the normal
 * /auth/staff/otp/verify (PPL-R2-05). So that is 'warn', naming the way in.
 * A floor login with no phone stays 'error': both paths key the code on the
 * phone number, so nothing can sign that person in.
 */
export function staffCodeLoginHealth(input: {
  whatsappConfigured: boolean
  floorStaff: number
  floorStaffWithoutPhone: number
}): { check: HealthLevel; detail?: string } {
  const { whatsappConfigured, floorStaff, floorStaffWithoutPhone } = input
  if (floorStaffWithoutPhone > 0) {
    return {
      check: 'error',
      detail: `${floorStaffWithoutPhone} floor-role staff have no phone number on file, so no sign-in code (sent or handed over in person) can reach them. Add their number on Workforce.`,
    }
  }
  if (whatsappConfigured) return { check: 'ok' }
  if (floorStaff === 0) {
    return {
      check: 'warn',
      detail:
        'WhatsApp is not configured, so sign-in codes cannot be sent. No floor-role staff exist yet; once they do, a manager signs them in with an in-person code from Workforce ("Sign-in code" next to their name) until WhatsApp is set up.',
    }
  }
  return {
    check: 'warn',
    detail:
      `WhatsApp (WHATSAPP_API_URL/WHATSAPP_API_KEY) is not configured, so sign-in codes cannot be sent to ${floorStaff} floor-role staff. Until it is, a manager signs them in with an in-person code from Workforce ("Sign-in code" next to their name).`,
  }
}
