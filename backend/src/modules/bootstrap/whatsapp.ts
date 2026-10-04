// ONE-OFF, TEMPORARY (2026-10-04): lets the operator's assistant set the
// WhatsApp gateway without an admin login. Remove in the next deploy.
//
// Guarded three ways: the caller must present a secret whose SHA-256 matches
// the constant below (the secret itself is not in the repo or the image), the
// route refuses after EXPIRES_AT, and it refuses after one successful use.
// It can do exactly one thing: store the gateway URL + key (the same settings
// rows admin → Configuration → WhatsApp writes) and send one test message to
// the CEO's own phone.

import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { WA_URL_KEY, WA_KEY_KEY, invalidateWhatsappConfig, sendText } from '../../lib/whatsapp.js'
import { audit } from '../../lib/audit.js'

const SECRET_SHA256 = '2e57de49ff808d8cc7b93f6049a4f9daee2f09b0109820facb5bf7ca087a71cf'
const EXPIRES_AT = new Date('2026-10-04T14:06:19Z')
const USED_KEY = 'bootstrap.whatsapp.usedAt'

export async function whatsappBootstrapRoutes(fastify: FastifyInstance) {
  fastify.post('/whatsapp', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const given = String(req.headers['x-bootstrap-secret'] ?? '')
    const a = Buffer.from(crypto.createHash('sha256').update(given).digest('hex'))
    const b = Buffer.from(SECRET_SHA256)
    if (!given || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return reply.status(404).send()
    if (Date.now() > EXPIRES_AT.getTime()) return reply.status(404).send()
    if (await prisma.setting.findUnique({ where: { key: USED_KEY } })) return reply.status(410).send({ error: 'already used' })

    const body = z.object({
      apiUrl: z.string().regex(/^https:\/\/\S+$/).max(500),
      apiKey: z.string().min(8).max(200),
    }).parse(req.body)

    await prisma.$transaction([
      prisma.setting.upsert({ where: { key: WA_URL_KEY }, create: { key: WA_URL_KEY, value: body.apiUrl }, update: { value: body.apiUrl } }),
      prisma.setting.upsert({ where: { key: WA_KEY_KEY }, create: { key: WA_KEY_KEY, value: body.apiKey }, update: { value: body.apiKey } }),
    ])
    invalidateWhatsappConfig()

    const ceos = await prisma.user.findMany({
      where: { role: 'admin', deletedAt: null, phone: { not: null } },
      select: { id: true, phone: true },
      orderBy: { createdAt: 'asc' },
      take: 1,
    })
    let test: { sentTo: string | null; ok: boolean; error?: string } = { sentTo: null, ok: false, error: 'no CEO phone on file' }
    if (ceos[0]?.phone) {
      const digits = ceos[0].phone.replace(/\D/g, '').replace(/^0/, '92')
      try {
        await sendText(digits, 'servd: WhatsApp gateway connected. Signup and sign-in codes will arrive here.')
        test = { sentTo: `…${digits.slice(-4)}`, ok: true }
      } catch (e) {
        test = { sentTo: `…${digits.slice(-4)}`, ok: false, error: (e as Error).message.slice(0, 200) }
      }
    }

    await prisma.setting.upsert({ where: { key: USED_KEY }, create: { key: USED_KEY, value: new Date().toISOString() }, update: { value: new Date().toISOString() } })
    await audit({
      category: 'identity', action: 'integration.whatsapp_bootstrap', entity: 'Setting',
      userId: null, tenantId: null, userEmail: 'bootstrap',
      after: { apiUrl: body.apiUrl, apiKeyHint: `${body.apiKey.slice(0, 6)}…${body.apiKey.slice(-4)}`, test },
    })
    return { saved: true, test }
  })
}
