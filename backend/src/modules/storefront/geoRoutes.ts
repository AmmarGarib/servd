// Pin → address line for checkout (owner, 2026-10-16: "Keep address in our own
// server"). The customer's browser only ever talks to servd: it sends the pin
// here, and servd asks OpenStreetMap Nominatim from the server, with no cookie,
// no customer id and not the customer's IP. Signed-in customers only (checkout
// needs a session), rate-limited, Pakistan only, coordinates rounded to ~11 m
// before they leave servd, answers cached in memory. Best effort: any failure
// is `{ line: null }` and the checkout field simply stays editable. On a
// practice copy (SERVD_SANDBOX=1) no outbound call is made.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireCustomerAuth } from '../auth/middleware.js'
import { sandboxBlocks } from '../../lib/sandbox.js'

const CACHE_MAX = 2000
const cache = new Map<string, string | null>()
const USER_AGENT = 'servd/1.0 (servd.pk; servd@gsfoods.pk)'

/** Pakistan's bounding box, generous: a pin outside it is never looked up. */
const inPakistan = (lat: number, lng: number) => lat >= 23 && lat <= 37.5 && lng >= 60 && lng <= 78

export function addressLineOf(d: { display_name?: string; address?: Record<string, string> }): string | null {
  const a = d.address ?? {}
  const street = [a['house_number'], a['road'] ?? a['pedestrian'] ?? a['footway']].filter(Boolean).join(' ')
  const area = a['neighbourhood'] ?? a['suburb'] ?? a['quarter'] ?? a['residential']
  const city = a['city'] ?? a['town'] ?? a['village'] ?? a['state_district']
  const line = [street, area, city].filter(Boolean).join(', ') || d.display_name || ''
  return line.slice(0, 200) || null
}

export async function geoRoutes(fastify: FastifyInstance) {
  fastify.get('/geo/reverse', {
    preHandler: requireCustomerAuth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req) => {
    const q = z.object({ lat: z.coerce.number().finite(), lng: z.coerce.number().finite() }).parse(req.query)
    if (!inPakistan(q.lat, q.lng)) return { line: null }
    const lat = q.lat.toFixed(4)
    const lng = q.lng.toFixed(4)
    const key = `${lat},${lng}`
    if (cache.has(key)) return { line: cache.get(key) ?? null }
    if (sandboxBlocks('geocode', { summary: 'reverse lookup' })) return { line: null }
    let line: string | null = null
    let answered = false
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${lat}&lon=${lng}`, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(4000),
      })
      if (res.ok) { line = addressLineOf(await res.json() as { display_name?: string; address?: Record<string, string> }); answered = true }
    } catch { line = null }
    if (answered) {   // never cache an outage
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
      cache.set(key, line)
    }
    return { line }
  })
}
