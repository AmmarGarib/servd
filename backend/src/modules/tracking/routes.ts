// Public campaign-engagement tracking — no auth (recipients click these from
// their email / SMS). Two endpoints:
//
//   GET /t/c/:id?u=<target>  → record a click on CampaignSend :id, 302 → target
//   GET /t/o/:id             → record an open on CampaignSend :id, return 1x1 gif
//
// Safety:
//  - Tracking is best-effort (updateMany, no throw on unknown id) — a missing
//    or bad id must never stop the redirect / pixel.
//  - Open-redirect protection: we only ever 302 to a relative path or a host
//    under the operator's own domain; anything else falls back to the storefront
//    home. This stops the tracker being abused as a phishing redirector.

import type { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/prisma.js'

const SAFE_DEFAULT = process.env['STOREFRONT_URL'] ?? 'https://servd-app.garibsons.app'
const ALLOWED_SUFFIXES = ['garibsons.app']

function safeTarget(u: string | undefined): string {
  if (!u) return SAFE_DEFAULT
  try {
    // Relative path → resolve against the storefront origin.
    if (u.startsWith('/')) return SAFE_DEFAULT.replace(/\/+$/, '') + u
    const url = new URL(u)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return SAFE_DEFAULT
    const host = url.hostname.toLowerCase()
    if (ALLOWED_SUFFIXES.some((s) => host === s || host.endsWith('.' + s))) return url.toString()
    try { if (host === new URL(SAFE_DEFAULT).hostname) return url.toString() } catch { /* ignore */ }
    return SAFE_DEFAULT
  } catch {
    return SAFE_DEFAULT
  }
}

// 1x1 transparent GIF.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

export async function trackingRoutes(fastify: FastifyInstance) {
  // Click → redirect
  fastify.get<{ Params: { id: string }; Querystring: { u?: string } }>('/c/:id', async (req, reply) => {
    const target = safeTarget(req.query.u)
    try {
      await prisma.campaignSend.updateMany({ where: { id: req.params.id }, data: { clickCount: { increment: 1 } } })
      await prisma.campaignSend.updateMany({ where: { id: req.params.id, firstClickedAt: null }, data: { firstClickedAt: new Date() } })
    } catch { /* best-effort */ }
    return reply.redirect(target)
  })

  // Open pixel
  fastify.get<{ Params: { id: string } }>('/o/:id', async (req, reply) => {
    try {
      await prisma.campaignSend.updateMany({ where: { id: req.params.id }, data: { openCount: { increment: 1 } } })
      await prisma.campaignSend.updateMany({ where: { id: req.params.id, firstOpenedAt: null }, data: { firstOpenedAt: new Date() } })
    } catch { /* best-effort */ }
    return reply
      .header('Content-Type', 'image/gif')
      .header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
      .send(PIXEL)
  })
}
