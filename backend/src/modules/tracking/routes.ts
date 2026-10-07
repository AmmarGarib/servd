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

const SAFE_DEFAULT = process.env['STOREFRONT_URL'] ?? 'https://servd.pk'
// servd.pk is the live storefront; links to it were being bounced to the
// fallback because only the old tunnel domain was listed.
const ALLOWED_SUFFIXES = ['servd.pk', 'simmer.pk', 'stackd.pk', 'flipd.pk', 'gsfoods.pk']

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

  // Unsubscribe. GET shows a page with a button; only the POST acts.
  //
  // A bare GET that unsubscribed would be triggered by link scanners — the
  // security gateways many workplaces run fetch every link in an incoming
  // email — and people would be silently dropped without ever clicking.
  fastify.get<{ Params: { id: string } }>('/u/:id', async (req, reply) => {
    const id = req.params.id.replace(/[^a-zA-Z0-9-]/g, '')
    return reply.header('Content-Type', 'text/html; charset=utf-8').send(page(
      'Stop marketing messages?',
      `<p>You'll stop getting offers and news from us. Order updates and sign-in codes are not affected.</p>
       <form method="POST" action="/api/v1/t/u/${id}"><button type="submit">Unsubscribe</button></form>`,
    ))
  })

  fastify.post<{ Params: { id: string } }>('/u/:id', async (req, reply) => {
    try {
      const send = await prisma.campaignSend.findUnique({ where: { id: req.params.id }, select: { customerId: true } })
      if (send) {
        await prisma.customer.updateMany({
          where: { id: send.customerId, marketingOptOutAt: null },
          data: { marketingOptOutAt: new Date(), marketingOptIn: false },
        })
      }
    } catch { /* same answer either way — never reveal whether an id exists */ }
    return reply.header('Content-Type', 'text/html; charset=utf-8').send(page(
      "You're unsubscribed",
      "<p>You won't get marketing messages from us any more. Order updates and sign-in codes will still reach you.</p>",
    ))
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

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#2D1E2F;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
main{max-width:380px}h1{font-size:22px;margin:0 0 8px}p{color:rgba(255,255,255,.75);font-size:14px;line-height:1.5}
button{margin-top:12px;background:#fff;color:#4E2A4F;border:0;border-radius:12px;padding:12px 20px;font-weight:800;font-size:14px;cursor:pointer}</style>
</head><body><main><h1>${title}</h1>${body}</main></body></html>`
}
